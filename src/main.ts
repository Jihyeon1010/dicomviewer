import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getSlice, openFiles, openFolder, selectSeries } from "./api";
import type { SeriesInfo, SliceData } from "./types";

function byId<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) throw new Error(`#${id} 요소를 찾을 수 없거나 타입이 다릅니다`);
  return el;
}

const viewport = byId("viewport", HTMLElement);
const canvas = byId("view", HTMLCanvasElement);
const overlayTL = byId("overlay-tl", HTMLDivElement);
const overlayBR = byId("overlay-br", HTMLDivElement);
const seriesSel = byId("series", HTMLSelectElement);
const presetSel = byId("preset", HTMLSelectElement);
const openBtn = byId("open", HTMLButtonElement);
const openFilesBtn = byId("open-files", HTMLButtonElement);
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2D 컨텍스트를 만들 수 없습니다");

// ---------- 상태 ----------
const state = { count: 0, index: 0, wl: 40, ww: 400, invert: false };
const view = { zoom: 1, panX: 0, panY: 0 };
let current: SliceData | null = null;
let seriesName = "";
let firstLoad = true; // 시리즈 로드 직후 한 번만 파일의 기본 WL/WW 적용
let fetchToken = 0;

// CT 기준 대표값입니다. 장비와 프로토콜에 따라 조금씩 조정해서 쓰세요.
const PRESETS: { name: string; wl: number; ww: number }[] = [
  { name: "뇌 (1)", wl: 40, ww: 80 },
  { name: "경막하 (2)", wl: 75, ww: 215 },
  { name: "연조직 (3)", wl: 40, ww: 400 },
  { name: "CTA (4)", wl: 150, ww: 600 },
  { name: "뼈 (5)", wl: 500, ww: 2000 },
  { name: "폐 (6)", wl: -600, ww: 1500 },
];

presetSel.replaceChildren(
  new Option("WL/WW 프리셋", ""),
  ...PRESETS.map((p, i) => new Option(p.name, String(i))),
);

// ---------- 표시 ----------
function showError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  overlayTL.textContent = `오류: ${msg}`;
  console.error(err);
}

function updateOverlay(): void {
  const s = current;
  overlayTL.textContent = [
    seriesName,
    state.count ? `Im ${state.index + 1} / ${state.count}` : "",
    s ? `${s.cols} × ${s.rows}` : "",
  ].filter(Boolean).join("\n");
  overlayBR.textContent =
    `WL ${Math.round(state.wl)}  WW ${Math.round(state.ww)}${state.invert ? "  (반전)" : ""}\n` +
    `Zoom ${Math.round(view.zoom * 100)}%`;
}

function applyTransform(): void {
  canvas.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${view.zoom})`;
}

function fitView(): void {
  if (!current) return;
  const r = viewport.getBoundingClientRect();
  view.zoom = Math.min(r.width / current.cols, r.height / current.rows);
  view.panX = (r.width - current.cols * view.zoom) / 2;
  view.panY = (r.height - current.rows * view.zoom) / 2;
  applyTransform();
}

function zoomAt(factor: number, cx: number, cy: number): void {
  const z2 = Math.min(50, Math.max(0.05, view.zoom * factor));
  const k = z2 / view.zoom;
  view.panX = cx - (cx - view.panX) * k;
  view.panY = cy - (cy - view.panY) * k;
  view.zoom = z2;
  applyTransform();
  updateOverlay();
}

function zoomCenter(factor: number): void {
  const r = viewport.getBoundingClientRect();
  zoomAt(factor, r.width / 2, r.height / 2);
}

// ---------- 렌더링 ----------
let img: ImageData | null = null;
let drawQueued = false;

function requestDraw(): void {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => {
    drawQueued = false;
    draw();
  });
}

function draw(): void {
  const s = current;
  if (!s) return;
  const { rows, cols, pixels, slope, intercept } = s;
  if (!img || img.width !== cols || img.height !== rows) {
    img = ctx!.createImageData(cols, rows);
  }
  const out = new Uint32Array(img.data.buffer);
  const lo = state.wl - state.ww / 2;
  const scale = 255 / state.ww;
  const flip = s.monochrome1 !== state.invert; // MONOCHROME1과 수동 반전은 서로 상쇄

  for (let i = 0; i < rows * cols; i++) {
    const hu = (pixels[i] as number) * slope + intercept;
    let v = (hu - lo) * scale;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (flip) v = 255 - v;
    const g = v | 0;
    out[i] = 0xff000000 | (g << 16) | (g << 8) | g; // little-endian ABGR
  }
  ctx!.putImageData(img, 0, 0);
  updateOverlay();
}

async function loadSlice(): Promise<void> {
  if (state.count === 0) return;
  const token = ++fetchToken;
  try {
    const slice = await getSlice(state.index);
    if (token !== fetchToken) return; // 더 최신 요청이 있음

    const dimsChanged = !current || current.rows !== slice.rows || current.cols !== slice.cols;
    current = slice;

    if (firstLoad) {
      if (slice.defaultWl !== null && slice.defaultWw !== null) {
        state.wl = slice.defaultWl;
        state.ww = slice.defaultWw;
      }
      firstLoad = false;
    }
    if (dimsChanged) {
      canvas.width = slice.cols;
      canvas.height = slice.rows;
      fitView();
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
  void loadSlice();
}

// ---------- 시리즈 로딩 ----------
async function loadSeries(uid: string): Promise<void> {
  try {
    state.count = await selectSeries(uid);
    state.index = 0;
    firstLoad = true;
    current = null;
    seriesName = seriesSel.selectedOptions[0]?.textContent ?? "";
    await loadSlice();
  } catch (err) {
    showError(err);
  }
}

async function showSeries(list: SeriesInfo[]): Promise<void> {
  seriesSel.replaceChildren(
    ...list.map((s) => new Option(`${s.description || s.uid} (${s.slice_count})`, s.uid)),
  );
  const first = list[0];
  if (first) await loadSeries(first.uid);
  else overlayTL.textContent = "DICOM 파일을 찾지 못했습니다";
}

openBtn.addEventListener("click", async () => {
  try {
    const dir = await open({ directory: true });
    if (typeof dir !== "string") return;
    overlayTL.textContent = "불러오는 중...";
    await showSeries(await openFolder(dir));
  } catch (err) {
    showError(err);
  }
});

openFilesBtn.addEventListener("click", async () => {
  try {
    // DICOM은 확장자가 없는 경우가 많아 필터를 걸지 않았습니다
    const picked = await open({ multiple: true });
    if (!Array.isArray(picked) || picked.length === 0) return;
    overlayTL.textContent = "불러오는 중...";
    await showSeries(await openFiles(picked));
  } catch (err) {
    showError(err);
  }
});

seriesSel.addEventListener("change", () => {
  void loadSeries(seriesSel.value);
  seriesSel.blur();
});

function applyPreset(i: number): void {
  const p = PRESETS[i];
  if (!p) return;
  state.wl = p.wl;
  state.ww = p.ww;
  requestDraw();
}

presetSel.addEventListener("change", () => {
  if (presetSel.value !== "") applyPreset(Number(presetSel.value));
  presetSel.value = "";
  presetSel.blur();
});

// ---------- 드래그 앤 드롭 (파일과 폴더 모두) ----------
void getCurrentWebview().onDragDropEvent(async (event) => {
  if (event.payload.type !== "drop" || event.payload.paths.length === 0) return;
  try {
    overlayTL.textContent = "불러오는 중...";
    await showSeries(await openFiles(event.payload.paths));
  } catch (err) {
    showError(err);
  }
});

// ---------- 마우스 ----------
// 휠: 슬라이스 스크롤, 트랙패드 핀치(ctrl+휠): 확대/축소
// 좌클릭 드래그: WL/WW, 우클릭 또는 Shift+드래그 또는 가운데 버튼: 이동
let wheelAcc = 0;
viewport.addEventListener(
  "wheel",
  (e: WheelEvent) => {
    e.preventDefault();
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

type DragMode = "window" | "pan";
interface Drag { mode: DragMode; x: number; y: number; wl: number; ww: number; panX: number; panY: number }
let drag: Drag | null = null;

viewport.addEventListener("contextmenu", (e) => e.preventDefault());

viewport.addEventListener("mousedown", (e: MouseEvent) => {
  const pan = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
  drag = {
    mode: pan ? "pan" : "window",
    x: e.clientX, y: e.clientY,
    wl: state.wl, ww: state.ww,
    panX: view.panX, panY: view.panY,
  };
  e.preventDefault();
});

window.addEventListener("mouseup", () => { drag = null; });

window.addEventListener("mousemove", (e: MouseEvent) => {
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (drag.mode === "pan") {
    view.panX = drag.panX + dx;
    view.panY = drag.panY + dy;
    applyTransform();
  } else {
    state.ww = Math.max(1, drag.ww + dx * 2);
    state.wl = drag.wl + dy * 2;
    requestDraw();
  }
});

viewport.addEventListener("dblclick", () => {
  fitView();
  updateOverlay();
});

// ---------- 키보드 ----------
window.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.target instanceof HTMLSelectElement) return;
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
    case "i": case "I": state.invert = !state.invert; requestDraw(); break;
    case "r": case "R":
      if (current?.defaultWl != null && current.defaultWw != null) {
        state.wl = current.defaultWl;
        state.ww = current.defaultWw;
      } else {
        state.wl = 40;
        state.ww = 400;
      }
      requestDraw();
      break;
    default:
      if (/^[1-6]$/.test(e.key)) applyPreset(Number(e.key) - 1);
      else return;
  }
  e.preventDefault();
});

updateOverlay();