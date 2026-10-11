import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getSlice, openFiles, openFolder, selectSeries } from "./api";
import { GLRenderer } from "./renderer";
import type { SeriesInfo, SliceData } from "./types";

function byId<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) throw new Error(`Element #${id} not found or has the wrong type`);
  return el;
}

const viewport = byId("viewport", HTMLElement);
const canvas = byId("view", HTMLCanvasElement);
const overlayTL = byId("overlay-tl", HTMLDivElement);
const overlayBR = byId("overlay-br", HTMLDivElement);
const emptyTitle = byId("empty-title", HTMLDivElement);
const emptySub = byId("empty-sub", HTMLDivElement);
const seriesList = byId("series-list", HTMLUListElement);
const presetSel = byId("preset", HTMLSelectElement);
const openBtn = byId("open", HTMLButtonElement);
const openFilesBtn = byId("open-files", HTMLButtonElement);
const invertBtn = byId("invert", HTMLButtonElement);
const fitBtn = byId("fit", HTMLButtonElement);
const resetBtn = byId("reset", HTMLButtonElement);
const slider = byId("slider", HTMLInputElement);
const toolButtons = document.querySelectorAll<HTMLButtonElement>("#tools .tool");

// ---------- State ----------
const state = { count: 0, index: 0, wl: 40, ww: 400, invert: false };
const view = { zoom: 1, panX: 0, panY: 0 };
let current: SliceData | null = null;
let seriesData: SeriesInfo[] = [];
let activeUid = "";
let seriesName = "";
let firstLoad = true; // apply the file's default WL/WW only once per series
let autoFit = true;   // keep the image fitted until the user zooms or pans
let fetchToken = 0;

// Typical CT values; adjust per scanner and protocol.
const PRESETS: { name: string; wl: number; ww: number }[] = [
  { name: "Brain (1)", wl: 40, ww: 80 },
  { name: "Subdural (2)", wl: 75, ww: 215 },
  { name: "Soft tissue (3)", wl: 40, ww: 400 },
  { name: "CTA (4)", wl: 150, ww: 600 },
  { name: "Bone (5)", wl: 500, ww: 2000 },
  { name: "Lung (6)", wl: -600, ww: 1500 },
];

presetSel.replaceChildren(
  new Option("WL/WW presets", ""),
  ...PRESETS.map((p, i) => new Option(p.name, String(i))),
);

// ---------- Tools ----------
type ToolId = "window" | "pan" | "zoom" | "scroll";
let tool: ToolId = "window";

function setTool(next: ToolId): void {
  tool = next;
  viewport.dataset.tool = next;
  for (const b of toolButtons) {
    const on = b.dataset.tool === next;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  }
}

for (const b of toolButtons) {
  b.addEventListener("click", () => setTool(b.dataset.tool as ToolId));
}
setTool("window");

// ---------- UI sync ----------
function showError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  overlayTL.textContent = `Error: ${msg}`;
  console.error(err);
}

function setEmpty(on: boolean, title?: string, sub?: string): void {
  viewport.classList.toggle("empty", on);
  if (title !== undefined) emptyTitle.textContent = title;
  if (sub !== undefined) emptySub.textContent = sub;
}

function syncControls(): void {
  const n = state.count;
  slider.max = String(Math.max(0, n - 1));
  slider.value = String(state.index);
  slider.disabled = n <= 1;
  invertBtn.classList.toggle("active", state.invert);
  invertBtn.setAttribute("aria-pressed", String(state.invert));
  for (const el of [invertBtn, fitBtn, resetBtn, presetSel]) el.disabled = n === 0;
}

function updateOverlay(): void {
  const s = current;
  overlayTL.textContent = [
    seriesName,
    state.count ? `Im ${state.index + 1} / ${state.count}` : "",
    s ? `${s.cols} × ${s.rows}` : "",
  ].filter(Boolean).join("\n");
  overlayBR.textContent = s
    ? `WL ${Math.round(state.wl)}  WW ${Math.round(state.ww)}${state.invert ? "  (inverted)" : ""}\n` +
      `Zoom ${Math.round(view.zoom * 100)}%`
    : "";
}

function renderSeriesList(): void {
  seriesList.replaceChildren(
    ...seriesData.map((s) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "series-item" + (s.uid === activeUid ? " active" : "");

      // textContent only: descriptions come from DICOM headers (untrusted input)
      const name = document.createElement("span");
      name.className = "series-name";
      name.textContent = s.description || "(no description)";
      const meta = document.createElement("span");
      meta.className = "series-meta";
      meta.textContent = `${s.slice_count} image${s.slice_count === 1 ? "" : "s"}`;

      btn.append(name, meta);
      btn.addEventListener("click", () => void loadSeries(s.uid));
      li.append(btn);
      return li;
    }),
  );
}

// ---------- View transform ----------
const clampZoom = (z: number): number => Math.min(50, Math.max(0.05, z));

function applyTransform(): void {
  canvas.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
}

function fitView(): void {
  if (!current) return;
  const r = viewport.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return;
  view.zoom = Math.min(r.width / current.cols, r.height / current.rows);
  view.panX = (r.width - current.cols * view.zoom) / 2;
  view.panY = (r.height - current.rows * view.zoom) / 2;
  autoFit = true;
  applyTransform();
}

function zoomAt(factor: number, cx: number, cy: number): void {
  const z2 = clampZoom(view.zoom * factor);
  const k = z2 / view.zoom;
  view.panX = cx - (cx - view.panX) * k;
  view.panY = cy - (cy - view.panY) * k;
  view.zoom = z2;
  autoFit = false;
  applyTransform();
  updateOverlay();
}

function zoomCenter(factor: number): void {
  const r = viewport.getBoundingClientRect();
  zoomAt(factor, r.width / 2, r.height / 2);
}

new ResizeObserver(() => {
  if (autoFit && current) {
    fitView();
    updateOverlay();
  }
}).observe(viewport);

// ---------- Rendering ----------
let drawQueued = false;

function requestDraw(): void {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

let renderer: GLRenderer | null = null;
try {
  renderer = new GLRenderer(canvas, () => requestDraw());
} catch (err) {
  showError(err);
}

// Window/level, inversion and rescaling all run in the fragment shader,
// so a redraw only updates uniforms and never touches the pixel data.
function draw(): void {
  if (!current || !renderer) return;
  renderer.draw({ wl: state.wl, ww: state.ww, invert: state.invert });
  updateOverlay();
}

async function loadSlice(): Promise<void> {
  if (state.count === 0) return;
  const token = ++fetchToken;
  try {
    const slice = await getSlice(state.index);
    if (token !== fetchToken) return; // a newer request superseded this one

    const dimsChanged = !current || current.rows !== slice.rows || current.cols !== slice.cols;
    current = slice;
    renderer?.upload(slice);

    if (firstLoad) {
      if (slice.defaultWl !== null && slice.defaultWw !== null) {
        state.wl = slice.defaultWl;
        state.ww = slice.defaultWw;
      }
      firstLoad = false;
    }
    if (dimsChanged) {
      // Resizing clears the drawing buffer, so draw right after
      canvas.width = slice.cols;
      canvas.height = slice.rows;
      if (autoFit) fitView();
    }
    draw();
  } catch (err) {
    showError(err);
  }
}

function gotoSlice(next: number): void {
  const clamped = Math.max(0, Math.min(state.count - 1, next));
  if (clamped === state.index) return;
  state.index = clamped;
  syncControls();
  updateOverlay();
  void loadSlice();
}

function resetWindow(): void {
  if (current?.defaultWl != null && current.defaultWw != null) {
    state.wl = current.defaultWl;
    state.ww = current.defaultWw;
  } else {
    state.wl = 40;
    state.ww = 400;
  }
  requestDraw();
}

function toggleInvert(): void {
  state.invert = !state.invert;
  syncControls();
  requestDraw();
}

function applyPreset(i: number): void {
  const p = PRESETS[i];
  if (!p) return;
  state.wl = p.wl;
  state.ww = p.ww;
  requestDraw();
}

// ---------- Loading ----------
async function loadSeries(uid: string): Promise<void> {
  try {
    state.count = await selectSeries(uid);
    state.index = 0;
    firstLoad = true;
    autoFit = true;
    current = null;
    activeUid = uid;
    seriesName = seriesData.find((s) => s.uid === uid)?.description ?? "";
    renderSeriesList();
    setEmpty(false);
    syncControls();
    await loadSlice();
  } catch (err) {
    showError(err);
  }
}

async function showSeries(list: SeriesInfo[]): Promise<void> {
  seriesData = list;
  activeUid = "";
  renderSeriesList();

  const first = list[0];
  if (!first) {
    current = null;
    state.count = 0;
    state.index = 0;
    seriesName = "";
    setEmpty(true, "No DICOM files found", "Check that the selection contains DICOM data");
    syncControls();
    updateOverlay();
    return;
  }
  await loadSeries(first.uid);
}

async function loadInputs(fetcher: () => Promise<SeriesInfo[]>): Promise<void> {
  try {
    overlayTL.textContent = "Loading...";
    await showSeries(await fetcher());
  } catch (err) {
    showError(err);
  }
}

openBtn.addEventListener("click", async () => {
  try {
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    await loadInputs(() => openFolder(dir));
  } catch (err) {
    showError(err);
  }
});

openFilesBtn.addEventListener("click", async () => {
  try {
    // No extension filter: DICOM files often have no extension
    const picked = await open({ multiple: true });
    if (!Array.isArray(picked) || picked.length === 0) return;
    await loadInputs(() => openFiles(picked));
  } catch (err) {
    showError(err);
  }
});

invertBtn.addEventListener("click", toggleInvert);
fitBtn.addEventListener("click", () => { fitView(); updateOverlay(); });
resetBtn.addEventListener("click", resetWindow);

presetSel.addEventListener("change", () => {
  if (presetSel.value !== "") applyPreset(Number(presetSel.value));
  presetSel.value = "";
  presetSel.blur();
});

slider.addEventListener("input", () => gotoSlice(Number(slider.value)));
slider.addEventListener("change", () => slider.blur());

// ---------- Drag and drop (files and folders) ----------
void getCurrentWebview().onDragDropEvent(async (event) => {
  const p = event.payload;
  if (p.type === "enter" || p.type === "over") {
    document.body.classList.add("dragging");
    return;
  }
  document.body.classList.remove("dragging");
  if (p.type !== "drop" || p.paths.length === 0) return;
  await loadInputs(() => openFiles(p.paths));
});

// ---------- Mouse ----------
// Wheel: scroll slices. Pinch (ctrl+wheel): zoom at the cursor.
// Left drag: active tool. Right / middle / Shift+left drag: pan.
let wheelAcc = 0;
viewport.addEventListener(
  "wheel",
  (e: WheelEvent) => {
    e.preventDefault();
    if (!current) return;
    if (e.ctrlKey) {
      const r = viewport.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
      return;
    }
    wheelAcc += e.deltaY;
    const steps = Math.trunc(wheelAcc / 40);
    if (steps !== 0) {
      wheelAcc -= steps * 40;
      gotoSlice(state.index + steps);
    }
  },
  { passive: false },
);

interface Drag {
  mode: ToolId;
  x: number; y: number;   // pointer start (client coordinates)
  ax: number; ay: number; // anchor point in viewport coordinates
  wl: number; ww: number;
  panX: number; panY: number; zoom: number;
  index: number;
}
let drag: Drag | null = null;

viewport.addEventListener("contextmenu", (e) => e.preventDefault());

viewport.addEventListener("mousedown", (e: MouseEvent) => {
  if (!current) return;
  const panOverride = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
  const r = viewport.getBoundingClientRect();
  drag = {
    mode: panOverride ? "pan" : tool,
    x: e.clientX, y: e.clientY,
    ax: e.clientX - r.left, ay: e.clientY - r.top,
    wl: state.wl, ww: state.ww,
    panX: view.panX, panY: view.panY, zoom: view.zoom,
    index: state.index,
  };
  e.preventDefault();
});

window.addEventListener("mouseup", () => { drag = null; });

window.addEventListener("mousemove", (e: MouseEvent) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;

  switch (drag.mode) {
    case "window":
      state.ww = Math.max(1, drag.ww + dx * 2);
      state.wl = drag.wl + dy * 2;
      requestDraw();
      break;
    case "pan":
      view.panX = drag.panX + dx;
      view.panY = drag.panY + dy;
      autoFit = false;
      applyTransform();
      break;
    case "zoom": {
      // Drag up to zoom in, anchored at the point where the drag started
      const z2 = clampZoom(drag.zoom * Math.exp(-dy * 0.01));
      const k = z2 / drag.zoom;
      view.panX = drag.ax - (drag.ax - drag.panX) * k;
      view.panY = drag.ay - (drag.ay - drag.panY) * k;
      view.zoom = z2;
      autoFit = false;
      applyTransform();
      updateOverlay();
      break;
    }
    case "scroll":
      gotoSlice(drag.index + Math.trunc(dy / 8)); // 8 px per slice
      break;
  }
});

viewport.addEventListener("dblclick", () => {
  fitView();
  updateOverlay();
});

// ---------- Keyboard ----------
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  switch (e.key) {
    case "ArrowUp": case "ArrowLeft": gotoSlice(state.index - 1); break;
    case "ArrowDown": case "ArrowRight": gotoSlice(state.index + 1); break;
    case "PageUp": gotoSlice(state.index - 10); break;
    case "PageDown": gotoSlice(state.index + 10); break;
    case "Home": gotoSlice(0); break;
    case "End": gotoSlice(state.count - 1); break;
    case "+": case "=": zoomCenter(1.25); break;
    case "-": zoomCenter(0.8); break;
    case "0": fitView(); updateOverlay(); break;
    case "i": case "I": toggleInvert(); break;
    case "r": case "R": resetWindow(); break;
    case "w": case "W": setTool("window"); break;
    case "p": case "P": setTool("pan"); break;
    case "z": case "Z": setTool("zoom"); break;
    case "s": case "S": setTool("scroll"); break;
    default:
      if (/^[1-6]$/.test(e.key)) applyPreset(Number(e.key) - 1);
      else return;
  }
  e.preventDefault();
});

syncControls();
updateOverlay();