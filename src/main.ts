import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getSlice, getSliceMeta, getThumbnail, openFiles, openFolder, selectSeries } from "./api";
import {
  edgeLabels,
  SCALE_BAR_HEIGHT,
  scaleBar,
  scaleBarPath,
  scaleBarPathVertical,
} from "./guides";
import { GLRenderer } from "./renderer";
import type { SeriesInfo, SliceData, SliceMeta } from "./types";

function byId<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) throw new Error(`Element #${id} not found or has the wrong type`);
  return el;
}

function byIdSvg<T extends SVGElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) throw new Error(`SVG element #${id} not found or has the wrong type`);
  return el;
}

const viewport = byId("viewport", HTMLElement);
const canvas = byId("view", HTMLCanvasElement);
const overlayTL = byId("overlay-tl", HTMLDivElement);
const overlayTR = byId("overlay-tr", HTMLDivElement);
const overlayBL = byId("overlay-bl", HTMLDivElement);
const overlayBR = byId("overlay-br", HTMLDivElement);
const markerT = byId("marker-t", HTMLDivElement);
const markerB = byId("marker-b", HTMLDivElement);
const markerL = byId("marker-l", HTMLDivElement);
const markerR = byId("marker-r", HTMLDivElement);
const scaleEl = byId("scalebar", HTMLDivElement);
const scaleSvg = byIdSvg("scalebar-svg", SVGSVGElement);
const scalePath = byIdSvg("scalebar-path", SVGPathElement);
const scaleLabel = byId("scalebar-label", HTMLDivElement);
const scaleVEl = byId("scalebar-v", HTMLDivElement);
const scaleVSvg = byIdSvg("scalebar-v-svg", SVGSVGElement);
const scaleVPath = byIdSvg("scalebar-v-path", SVGPathElement);
const scaleVLabel = byId("scalebar-v-label", HTMLDivElement);
const statusEl = byId("status", HTMLDivElement);
const emptyTitle = byId("empty-title", HTMLDivElement);
const emptySub = byId("empty-sub", HTMLDivElement);
const seriesList = byId("series-list", HTMLUListElement);
const presetSel = byId("preset", HTMLSelectElement);
const openBtn = byId("open", HTMLButtonElement);
const openFilesBtn = byId("open-files", HTMLButtonElement);
const invertBtn = byId("invert", HTMLButtonElement);
const fitBtn = byId("fit", HTMLButtonElement);
const resetBtn = byId("reset", HTMLButtonElement);
const infoBtn = byId("info", HTMLButtonElement);
const markersBtn = byId("markers", HTMLButtonElement);
const anonBtn = byId("anonymize", HTMLButtonElement);
const slider = byId("slider", HTMLInputElement);
const toolButtons = document.querySelectorAll<HTMLButtonElement>("#tools .tool");

// ---------- Persisted preferences ----------
function loadPref(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage can be unavailable; fall back to defaults
  }
}

function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore: preferences are a convenience only
  }
}

// ---------- State ----------
const state = { count: 0, index: 0, wl: 40, ww: 400, invert: false };
const view = { zoom: 1, panX: 0, panY: 0 };
let current: SliceData | null = null;
let meta: SliceMeta | null = null;
let seriesData: SeriesInfo[] = [];

const THUMB_PX = 112; // rendered at 2x the 56 px CSS size for high-DPI screens
const thumbs = new Map<string, ImageData>();
const thumbCanvases = new Map<string, HTMLCanvasElement>();
let thumbRun = 0; // bumped to cancel thumbnail loading for a previous selection

let activeUid = "";
let seriesName = "";
let firstLoad = true; // apply the file's default WL/WW only once per series
let autoFit = true;   // keep the image fitted until the user zooms or pans
let fetchToken = 0;

type OverlayMode = "full" | "minimal" | "off";
const OVERLAY_MODES: OverlayMode[] = ["full", "minimal", "off"];
const OVERLAY_LABEL: Record<OverlayMode, string> = {
  full: "Full",
  minimal: "Minimal",
  off: "Off",
};
const savedMode = loadPref("overlay");
let overlayMode: OverlayMode = OVERLAY_MODES.find((m) => m === savedMode) ?? "full";
let anonymize = loadPref("anonymize") === "1";
let markersOn = loadPref("markers") !== "0"; // on by default

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

// ---------- Status line ----------
function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function showError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  setStatus(`Error: ${msg}`, true);
  console.error(err);
}

// ---------- Overlay formatting ----------
type Maybe = string | false | null | undefined;

function compact(items: Maybe[]): string[] {
  return items.filter((x): x is string => typeof x === "string" && x !== "");
}

// DICOM person names use '^' as the component separator
const cleanName = (s: string): string => s.replace(/\^+/g, " ").trim();

function fmtDate(d: string): string {
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
}

function fmtTime(t: string): string {
  const m = /^(\d{2})(\d{2})(\d{2})/.exec(t);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : t;
}

// "034Y" -> "34Y"
const fmtAge = (a: string): string => a.replace(/^0+(?=\d)/, "");

// Rounds to `digits` decimals and drops trailing zeros
const num = (v: number, digits = 2): string => String(+v.toFixed(digits));

function patientLines(m: SliceMeta): string[] {
  const demo = [m.patient_sex, fmtAge(m.patient_age)].filter(Boolean).join(" · ");
  if (anonymize) return compact(["Anonymized", demo]);
  return compact([
    cleanName(m.patient_name),
    m.patient_id && `ID ${m.patient_id}`,
    m.patient_birth_date && `DOB ${fmtDate(m.patient_birth_date)}`,
    demo,
  ]);
}

function studyLines(m: SliceMeta | null): string[] {
  const desc = m?.series_description || seriesName;
  if (!m) return compact([desc]);
  const seriesLine = m.series_number
    ? `Se ${m.series_number}${desc ? `: ${desc}` : ""}`
    : desc;
  return compact([
    !anonymize && m.institution,
    m.study_description,
    !anonymize && [fmtDate(m.study_date), fmtTime(m.study_time)].filter(Boolean).join(" "),
    seriesLine,
    [m.modality, m.manufacturer_model].filter(Boolean).join(" · "),
  ]);
}

function imageLines(s: SliceData | null, m: SliceMeta | null): string[] {
  const position = m
    ? [
        m.slice_location !== null && `Loc ${num(m.slice_location, 1)} mm`,
        m.slice_thickness !== null && `Thk ${num(m.slice_thickness)} mm`,
      ].filter(Boolean).join("  ")
    : "";
  const exposure = m
    ? [
        m.kvp !== null && `${num(m.kvp, 0)} kVp`,
        m.tube_current !== null && `${num(m.tube_current, 0)} mA`,
      ].filter(Boolean).join("  ")
    : "";
  // pixel_spacing is [row, column]; shown as horizontal x vertical, like the matrix size
  const spacing = m?.pixel_spacing
    ? `Px ${num(m.pixel_spacing[1], 3)} × ${num(m.pixel_spacing[0], 3)} mm`
    : "";
  return compact([
    state.count ? `Im ${state.index + 1} / ${state.count}` : "",
    s && `${s.cols} × ${s.rows}`,
    position,
    exposure,
    spacing,
  ]);
}

function updateTextOverlays(): void {
  const s = current;
  const m = meta;

  if (overlayMode === "off") {
    for (const el of [overlayTL, overlayTR, overlayBL, overlayBR]) el.textContent = "";
    return;
  }

  const full = overlayMode === "full";
  overlayTL.textContent = full && m ? patientLines(m).join("\n") : "";
  overlayTR.textContent = full ? studyLines(m).join("\n") : "";
  overlayBL.textContent = full
    ? imageLines(s, m).join("\n")
    : state.count
      ? `Im ${state.index + 1} / ${state.count}`
      : "";
  overlayBR.textContent = s
    ? `WL ${Math.round(state.wl)}  WW ${Math.round(state.ww)}${state.invert ? "  (inverted)" : ""}\n` +
      `Zoom ${Math.round(view.zoom * 100)}%`
    : "";
}

// Orientation markers and scale bar. Independent of the text overlay mode.
function updateGuides(): void {
  const show = markersOn && current !== null;

  const labels = show ? edgeLabels(meta) : null;
  markerT.textContent = labels?.top ?? "";
  markerB.textContent = labels?.bottom ?? "";
  markerL.textContent = labels?.left ?? "";
  markerR.textContent = labels?.right ?? "";

  // Screen pixels per millimetre along the horizontal image axis.
  // pixel_spacing is [row, column]; the column spacing is the horizontal step.
  const colSpacing = meta?.pixel_spacing?.[1] ?? 0;
  const bar = show && colSpacing > 0 ? scaleBar(view.zoom / colSpacing) : null;
  scaleEl.classList.toggle("on", bar !== null);
  if (bar) {
    scaleSvg.setAttribute("width", String(bar.px + 2));
    scaleSvg.setAttribute("height", String(SCALE_BAR_HEIGHT));
    scalePath.setAttribute("d", scaleBarPath(bar));
    scaleLabel.textContent = bar.label;
  }

    // Vertical ruler: the row spacing is the vertical step in millimetres
  const rowSpacing = meta?.pixel_spacing?.[0] ?? 0;
  const barV = show && rowSpacing > 0 ? scaleBar(view.zoom / rowSpacing) : null;
  scaleVEl.classList.toggle("on", barV !== null);
  if (barV) {
    scaleVSvg.setAttribute("width", String(SCALE_BAR_HEIGHT));
    scaleVSvg.setAttribute("height", String(barV.px + 2));
    scaleVPath.setAttribute("d", scaleBarPathVertical(barV));
    scaleVLabel.textContent = barV.label;
  }
}

function updateOverlay(): void {
  updateTextOverlays();
  updateGuides();
}

// ---------- UI sync ----------
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

  infoBtn.textContent = `Info: ${OVERLAY_LABEL[overlayMode]}`;
  markersBtn.classList.toggle("active", markersOn);
  markersBtn.setAttribute("aria-pressed", String(markersOn));
  anonBtn.classList.toggle("active", anonymize);
  anonBtn.setAttribute("aria-pressed", String(anonymize));
}

function cycleOverlay(): void {
  const next = OVERLAY_MODES[(OVERLAY_MODES.indexOf(overlayMode) + 1) % OVERLAY_MODES.length];
  overlayMode = next ?? "full";
  savePref("overlay", overlayMode);
  syncControls();
  updateOverlay();
}

function toggleMarkers(): void {
  markersOn = !markersOn;
  savePref("markers", markersOn ? "1" : "0");
  syncControls();
  updateOverlay();
}

function toggleAnonymize(): void {
  anonymize = !anonymize;
  savePref("anonymize", anonymize ? "1" : "0");
  syncControls();
  updateOverlay();
}

function renderSeriesList(): void {
  thumbCanvases.clear();
  seriesList.replaceChildren(
    ...seriesData.map((s) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "series-item" + (s.uid === activeUid ? " active" : "");

      const thumb = document.createElement("canvas");
      thumb.className = "series-thumb";
      thumbCanvases.set(s.uid, thumb);
      paintThumb(s.uid); // already-loaded thumbnails survive list re-renders

      // textContent only: descriptions come from DICOM headers (untrusted input)
      const name = document.createElement("span");
      name.className = "series-name";
      name.textContent = s.description || "(no description)";
      const info = document.createElement("span");
      info.className = "series-meta";
      info.textContent = `${s.slice_count} image${s.slice_count === 1 ? "" : "s"}`;
      const text = document.createElement("span");
      text.className = "series-text";
      text.append(name, info);

      btn.append(thumb, text);
      btn.addEventListener("click", () => void loadSeries(s.uid));
      li.append(btn);
      return li;
    }),
  );
}

function paintThumb(uid: string): void {
  const img = thumbs.get(uid);
  const c = thumbCanvases.get(uid);
  if (!img || !c) return;
  c.width = img.width;
  c.height = img.height;
  c.getContext("2d")?.putImageData(img, 0, 0);
}

// Loads thumbnails in the background, three at a time
async function loadThumbnails(list: SeriesInfo[]): Promise<void> {
  const run = ++thumbRun;
  const queue = list.filter((s) => !thumbs.has(s.uid));

  const worker = async (): Promise<void> => {
    for (let s = queue.shift(); s !== undefined; s = queue.shift()) {
      if (run !== thumbRun) return; // a newer selection superseded this one
      try {
        const img = await getThumbnail(s.uid, THUMB_PX);
        if (run !== thumbRun) return;
        thumbs.set(s.uid, img);
        paintThumb(s.uid);
      } catch (err) {
        // A missing thumbnail is not worth interrupting the user
        console.warn(`Thumbnail failed for series ${s.uid}`, err);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
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
    // Metadata is optional: a failure there must not block the image
    const [slice, m] = await Promise.all([
      getSlice(state.index),
      getSliceMeta(state.index).catch(() => null),
    ]);
    if (token !== fetchToken) return; // a newer request superseded this one

    const dimsChanged = !current || current.rows !== slice.rows || current.cols !== slice.cols;
    current = slice;
    meta = m;
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
    setStatus("");
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
    meta = null;
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
  thumbRun++; // cancels thumbnail loading for the previous selection
  thumbs.clear();
  seriesData = list;
  activeUid = "";
  renderSeriesList();

  const first = list[0];
  if (!first) {
    current = null;
    meta = null;
    state.count = 0;
    state.index = 0;
    seriesName = "";
    setStatus("");
    setEmpty(true, "No DICOM files found", "Check that the selection contains DICOM data");
    syncControls();
    updateOverlay();
    return;
  }
  await loadSeries(first.uid);
  void loadThumbnails(list);
}

async function loadInputs(fetcher: () => Promise<SeriesInfo[]>): Promise<void> {
  try {
    setStatus("Loading...");
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
infoBtn.addEventListener("click", cycleOverlay);
markersBtn.addEventListener("click", toggleMarkers);
anonBtn.addEventListener("click", toggleAnonymize);

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
    case "o": case "O": cycleOverlay(); break;
    case "m": case "M": toggleMarkers(); break;
    case "a": case "A": toggleAnonymize(); break;
    default:
      if (/^[1-6]$/.test(e.key)) applyPreset(Number(e.key) - 1);
      else return;
  }
  e.preventDefault();
});

syncControls();
updateOverlay();