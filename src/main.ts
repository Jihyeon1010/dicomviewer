import { open } from "@tauri-apps/plugin-dialog";
import { getSlice, openFolder, selectSeries } from "./api";
import type { ViewState } from "./types";

function byId<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) {
    throw new Error(`#${id} 요소를 찾을 수 없거나 타입이 다릅니다`);
  }
  return el;
}

const canvas = byId("view", HTMLCanvasElement);
const info = byId("info", HTMLSpanElement);
const seriesSel = byId("series", HTMLSelectElement);
const openBtn = byId("open", HTMLButtonElement);
const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2D context could not be created");

const state: ViewState = { count: 0, index: 0, wl: 40, ww: 400 };

// prevent previous response from overwriting the latest screen when scrolling quickly
let renderToken = 0;

async function render(): Promise<void> {
  if (state.count === 0) return;
  const token = ++renderToken;

  let slice;
  try {
    slice = await getSlice(state.index);
  } catch (err) {
    info.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  if (token !== renderToken) return; // 

  const { rows, cols, pixels } = slice;
  canvas.width = cols;
  canvas.height = rows;
  const img = ctx!.createImageData(cols, rows);
  const lo = state.wl - state.ww / 2;
  const scale = 255 / state.ww;

  // TODO: Rescale Slope/Intercept(HU transformation), MONOCHROME1 reversal
  for (let i = 0; i < rows * cols; i++) {
    const v = Math.max(0, Math.min(255, ((pixels[i] as number) - lo) * scale));
    const o = i * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
    img.data[o + 3] = 255;
  }
  ctx!.putImageData(img, 0, 0);
  info.textContent = `${state.index + 1} / ${state.count}  WL ${Math.round(state.wl)} WW ${Math.round(state.ww)}`;
}

async function loadSeries(uid: string): Promise<void> {
  state.count = await selectSeries(uid);
  state.index = 0;
  await render();
}

openBtn.addEventListener("click", async () => {
  const dir = await open({ directory: true });
  if (typeof dir !== "string") return;

  const list = await openFolder(dir);
  seriesSel.replaceChildren(
    ...list.map((s) => {
      const opt = document.createElement("option");
      opt.value = s.uid;
      opt.textContent = `${s.description || s.uid} (${s.slice_count})`;
      return opt;
    }),
  );
  const first = list[0];
  if (first) await loadSeries(first.uid);
  else info.textContent = "DICOM files not found in the selected folder.";
});

seriesSel.addEventListener("change", () => void loadSeries(seriesSel.value));

canvas.addEventListener(
  "wheel",
  (e: WheelEvent) => {
    e.preventDefault();
    const next = state.index + Math.sign(e.deltaY);
    state.index = Math.max(0, Math.min(state.count - 1, next));
    void render();
  },
  { passive: false },
);

interface DragStart { x: number; y: number; wl: number; ww: number }
let drag: DragStart | null = null;

canvas.addEventListener("mousedown", (e: MouseEvent) => {
  drag = { x: e.clientX, y: e.clientY, wl: state.wl, ww: state.ww };
});
window.addEventListener("mouseup", () => { drag = null; });
window.addEventListener("mousemove", (e: MouseEvent) => {
  if (!drag) return;
  state.ww = Math.max(1, drag.ww + (e.clientX - drag.x) * 2);
  state.wl = drag.wl + (e.clientY - drag.y) * 2;
  void render();
});
