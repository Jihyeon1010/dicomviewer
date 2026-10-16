import { open, save } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { buildVolume, getThumbnail, openFiles, openFolder, savePng } from "./api";
import { byId } from "./dom";
import { compact, num } from "./format";
import { mountIcons, setIcon, setLabel } from "./icons";
import {
  ACTION_BY_ID,
  ACTIONS,
  buildLookup,
  comboFromEvent,
  formatCombo,
  PRESET_COUNT,
  resolveBindings,
  type Bindings,
} from "./keymap";
import { LAYOUT_PRESETS, MAX_COLS, MAX_ROWS, type Layout } from "./layout";
import { installMenu, type AppMenu } from "./menu";
import { Mpr, type Slab } from "./mpr";
import { createSettingsDialog } from "./settings-dialog";
import {
  loadSettings,
  OVERLAY_MODES,
  saveSettings,
  type OverlayMode,
  type Settings,
  type SliderPosition,
} from "./settings";
import { seriesSource, sliceCache } from "./slice-cache";
import { createTagsDialog } from "./tags-dialog";
import type { SeriesInfo, SlabMode, VolumeInfo } from "./types";
import { syncedIndex, Viewport, type ToolId, type ViewportHost } from "./viewport";
import { ORIENT_MODES, type OrientMode } from "./orient-auto";

// ---------- Elements ----------
const viewportsEl = byId("viewports", HTMLDivElement);
const statusEl = byId("status", HTMLDivElement);
const seriesList = byId("series-list", HTMLUListElement);
const presetSel = byId("preset", HTMLSelectElement);
const openBtn = byId("open", HTMLButtonElement);
const openFilesBtn = byId("open-files", HTMLButtonElement);
const invertBtn = byId("invert", HTMLButtonElement);
const fitBtn = byId("fit", HTMLButtonElement);
const resetBtn = byId("reset", HTMLButtonElement);
const rotCcwBtn = byId("rot-ccw", HTMLButtonElement);
const rotCwBtn = byId("rot-cw", HTMLButtonElement);
const flipHBtn = byId("flip-h", HTMLButtonElement);
const flipVBtn = byId("flip-v", HTMLButtonElement);
const cineBtn = byId("cine", HTMLButtonElement);
const infoBtn = byId("info", HTMLButtonElement);
const markersBtn = byId("markers", HTMLButtonElement);
const anonBtn = byId("anonymize", HTMLButtonElement);
const tagsBtn = byId("tags-btn", HTMLButtonElement);
const settingsBtn = byId("settings-open", HTMLButtonElement);
const syncScrollBtn = byId("sync-scroll", HTMLButtonElement);
const syncWindowBtn = byId("sync-window", HTMLButtonElement);
const mprBtn = byId("mpr", HTMLButtonElement);
const calBackdrop = byId("cal-backdrop", HTMLDivElement);
const calInfo = byId("cal-info", HTMLDivElement);
const calValue = byId("cal-value", HTMLInputElement);
const calUnit = byId("cal-unit", HTMLSelectElement);
const calOk = byId("cal-ok", HTMLButtonElement);
const calCancel = byId("cal-cancel", HTMLButtonElement);
const calError = byId("cal-error", HTMLDivElement);
const orientModeBtn = byId("orient-mode", HTMLButtonElement);
const crossBtn = byId("cross", HTMLButtonElement);
const slabModeSel = byId("slab-mode", HTMLSelectElement);
const slabThickSel = byId("slab-thick", HTMLSelectElement);
const slider = byId("slider", HTMLInputElement);
const stageEl = byId("stage", HTMLElement);
const sliderBar = byId("slider-bar", HTMLDivElement);
const sliderPosBtn = byId("slider-pos", HTMLButtonElement);
const layoutWrap = byId("layout-wrap", HTMLDivElement);
const layoutBtn = byId("layout-btn", HTMLButtonElement);
const layoutPop = byId("layout-pop", HTMLDivElement);
const layoutGrid = byId("layout-grid", HTMLDivElement);
const layoutLabel = byId("layout-label", HTMLDivElement);
const toolButtons = document.querySelectorAll<HTMLButtonElement>(".tool");

// ---------- Settings ----------
let settings: Settings = loadSettings();

function update(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  saveSettings(settings);
}

// ---------- State ----------
const OVERLAY_LABEL: Record<OverlayMode, string> = {
  full: "Full",
  minimal: "Minimal",
  off: "Off",
};

let layout: Layout = settings.layout;
let overlayMode: OverlayMode = settings.overlay;
let anonymize = settings.anonymize;
let markersOn = settings.markers;
let sliderPos: SliderPosition = settings.sliderPos;
let orientMode: OrientMode = settings.orientMode;
const ORIENT_LABEL: Record<OrientMode, string> = {
  standard: "Standard",
  stored: "As stored",
};
let syncScroll = settings.syncScroll;
let syncWindow = settings.syncWindow;
let tool: ToolId = "window";

let seriesData: SeriesInfo[] = [];
let hasLoaded = false;
let volume: { uid: string; info: VolumeInfo } | null = null;
let volumeBusy: string | null = null; // uid of the series being built
let appMenu: AppMenu | null = null;

// Multiplanar reformatting: the controller while it is on, and what to restore afterwards
interface MprSaved {
  layout: Layout;
  tool: ToolId;
  series: (SeriesInfo | null)[]; // what the first four views showed
}
let mpr: Mpr | null = null;
let mprSaved: MprSaved | null = null;
let mprBusy = false;

const THUMB_PX = 112; // rendered at 2x the 56 px CSS size for high-DPI screens
const thumbs = new Map<string, ImageData>();
const thumbCanvases = new Map<string, HTMLCanvasElement>();
const seriesButtons = new Map<string, HTMLButtonElement>();
let thumbRun = 0; // bumped to cancel thumbnail loading for a previous selection

// Typical CT values; adjust per scanner and protocol.
// Must contain exactly PRESET_COUNT entries (one preset.N action each).
const PRESETS: { name: string; wl: number; ww: number }[] = [
  { name: "Brain", wl: 40, ww: 80 },
  { name: "Subdural", wl: 75, ww: 215 },
  { name: "Soft tissue", wl: 40, ww: 400 },
  { name: "CTA", wl: 150, ww: 600 },
  { name: "Bone", wl: 500, ww: 2000 },
  { name: "Lung", wl: -600, ww: 1500 },
];

// ---------- Keymap ----------
let bindings: Bindings = resolveBindings(settings.keymap);
let lookup = buildLookup(bindings);

function rebuildKeymap(): void {
  bindings = resolveBindings(settings.keymap);
  lookup = buildLookup(bindings);
}

function setTip(el: HTMLElement, text: string, actionId: string): void {
  const keys = (bindings[actionId] ?? []).map(formatCombo);
  el.title = keys.length ? `${text} (${keys.join(", ")})` : text;
}

const TOOL_TIPS: Record<string, string> = {
  window: "Window / Level",
  pan: "Pan",
  zoom: "Zoom",
  scroll: "Scroll",
  cross: "Crosshair: click or drag to move all MPR views",
  length: "Measure a length",
  angle: "Measure an angle (three clicks)",
  ellipse: "Elliptical ROI",
  rect: "Rectangular ROI",
  calibrate: "Calibrate: measure an object of known size, then enter its real length",
  aneurysm: "Aneurysm: neck (2 clicks), dome (1 click), then optionally the dome width (2 clicks); double click or Enter to finish",
};

// Tooltips and preset labels are generated from the keymap, so they never go stale
function refreshTooltips(): void {
  for (const b of toolButtons) {
    const t = b.dataset["tool"] ?? "";
    setTip(b, TOOL_TIPS[t] ?? t, `tool.${t}`);
  }
  layoutBtn.title = `Choose how many views to show (up to ${MAX_COLS} × ${MAX_ROWS})`;
  setTip(mprBtn, "Multiplanar reformat: axial, coronal and sagittal views", "mpr.toggle");
  slabModeSel.title = "Projection through a slab: thin plane, MIP, MinIP or average";
  slabThickSel.title = "Slab thickness";
  setTip(syncScrollBtn, "Scroll linked views together", "sync.scroll");
  setTip(syncWindowBtn, "Share window / level between views", "sync.window");
  setTip(invertBtn, "Invert", "view.invert");
  setTip(fitBtn, "Fit to window", "view.fit");
  setTip(resetBtn, "Reset window", "view.resetWindow");
  setTip(rotCcwBtn, "Rotate counterclockwise", "view.rotateCCW");
  setTip(rotCwBtn, "Rotate clockwise", "view.rotateCW");
  setTip(flipHBtn, "Flip horizontally", "view.flipH");
  setTip(flipVBtn, "Flip vertically", "view.flipV");
  setTip(cineBtn, "Play / pause cine", "cine.toggle");
  setTip(infoBtn, "Overlay detail: full / minimal / off", "ui.overlay");
  setTip(markersBtn, "Orientation markers and scale bars", "ui.markers");
  setTip(sliderPosBtn, "Move the image slider to the bottom or the right side", "ui.slider");
  setTip(anonBtn, "Hide patient identifiers on screen", "ui.anonymize");
  setTip(tagsBtn, "DICOM tags of the shown image", "ui.tags");
  setTip(settingsBtn, "Settings and keyboard shortcuts", "ui.settings");
}

function refreshPresetOptions(): void {
  presetSel.replaceChildren(
    new Option("WL/WW presets", ""),
    ...PRESETS.map((p, i) => {
      const first = (bindings[`preset.${i + 1}`] ?? [])[0];
      return new Option(first ? `${p.name} (${formatCombo(first)})` : p.name, String(i));
    }),
  );
}

// ---------- Status line ----------
function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

function showError(err: unknown): void {
  setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
  console.error(err);
}

function flashStatus(text: string): void {
  setStatus(text);
  window.setTimeout(() => {
    if (statusEl.textContent === text) setStatus("");
  }, 3000);
}

// ---------- Viewports ----------
const host: ViewportHost = {
  tool: () => tool,
  overlay: () => ({ mode: overlayMode, anonymize, markers: markersOn }),
  activate: (vp) => activate(vp),
  sliceChanged: (vp) => syncSlices(vp),
  windowChanged: (vp) => syncWindows(vp),
  stateChanged: (vp) => {
    if (vp === active) syncControls();
  },
  pick: (vp, p) => mpr?.pick(vp, p),
  orientMode: () => orientMode,
  calibrate: (vp, pixels) => askCalibration(vp, pixels),
};

// Viewports are created on demand when the layout grows and are then kept,
// so going back to a larger layout restores what each view was showing.
const first = new Viewport(host);
const viewports: Viewport[] = [first];
viewportsEl.append(first.el);
let active: Viewport = first;

function ensureViewports(n: number): void {
  while (viewports.length < n) {
    const vp = new Viewport(host);
    viewports.push(vp);
    viewportsEl.append(vp.el);
  }
}

function cellCount(): number {
  return layout.cols * layout.rows;
}

function visible(): Viewport[] {
  return viewports.slice(0, cellCount());
}

function activate(vp: Viewport): void {
  if (vp === active) return;
  active.setActive(false);
  active = vp;
  vp.setActive(true);
  updateHighlights();
  syncControls();
}

function refreshAllOverlays(): void {
  for (const vp of viewports) vp.refreshOverlay();
}

// ---------- Linking ----------
function syncSlices(src: Viewport): void {
  // The views of an MPR show different planes of one volume; they follow the crosshair
  if (mpr?.owns(src)) {
    mpr.scrolled(src);
    return;
  }
  if (!syncScroll) return;
  for (const vp of visible()) {
    if (vp === src || mpr?.owns(vp)) continue;
    const idx = syncedIndex(src, vp);
    if (idx !== null) vp.goto(idx, false, true);
  }
}

function syncWindows(src: Viewport): void {
  // The views of an MPR always share their window
  const group = mpr?.owns(src) ? mpr.panes : null;
  for (const vp of visible()) {
    if (vp === src || !vp.series) continue;
    if (syncWindow || group?.includes(vp)) vp.setWindow(src.wl, src.ww, false);
  }
}

function toggleSyncScroll(): void {
  syncScroll = !syncScroll;
  update({ syncScroll });
  if (syncScroll) syncSlices(active);
  syncControls();
}

function toggleSyncWindow(): void {
  syncWindow = !syncWindow;
  update({ syncWindow });
  if (syncWindow) syncWindows(active);
  syncControls();
}

// ---------- Layout ----------
function applyLayout(next: Layout, persist = true, fill = true): void {
  layout = { cols: next.cols, rows: next.rows };
  if (persist) update({ layout });

  const n = cellCount();
  ensureViewports(n);
  viewportsEl.style.gridTemplateColumns = `repeat(${layout.cols}, minmax(0, 1fr))`;
  viewportsEl.style.gridTemplateRows = `repeat(${layout.rows}, minmax(0, 1fr))`;
  viewportsEl.classList.toggle("multi", n > 1);
  viewports.forEach((vp, i) => vp.setVisible(i < n));

  const shown = visible();
  if (!shown.includes(active)) activate(shown[0] ?? first);
  if (fill) void Promise.all(fillEmptyViewports());
  syncControls();
}

// Gives each empty visible viewport a series that is not on screen yet
function fillEmptyViewports(): Promise<void>[] {
  const onScreen = new Set<string>();
  for (const vp of visible()) if (vp.series) onScreen.add(vp.series.uid);
  const queue = seriesData.filter((s) => !onScreen.has(s.uid));

  const pending: Promise<void>[] = [];
  for (const vp of visible()) {
    if (vp.series) continue;
    const next = queue.shift();
    if (!next) break;
    pending.push(vp.setSeries(next));
  }
  afterAssignment();
  return pending;
}

function showInActive(s: SeriesInfo): void {
  // Replacing a view of the MPR would break it; leave the MPR first
  if (mpr) exitMpr(true);
  void active.setSeries(s);
  afterAssignment();
}

function afterAssignment(): void {
  applyVolumeLines();
  updateHighlights();
  refreshEmptyMessages();
  syncControls();
}

function refreshEmptyMessages(): void {
  for (const vp of viewports) {
    if (!hasLoaded) {
      vp.setEmptyMessage("Drop DICOM files or a folder here", "or use Open folder / Open files above");
    } else if (seriesData.length === 0) {
      vp.setEmptyMessage("No DICOM files found", "Check that the selection contains DICOM data");
    } else {
      vp.setEmptyMessage("No series shown", "Click a series in the sidebar to show it here");
    }
  }
}

// ---------- Layout picker ----------
// A MAX_COLS x MAX_ROWS grid; hovering a cell previews the layout up to that cell
const layoutCells: HTMLButtonElement[] = [];
for (let r = 1; r <= MAX_ROWS; r++) {
  for (let c = 1; c <= MAX_COLS; c++) {
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "layout-cell";
    cell.dataset["cols"] = String(c);
    cell.dataset["rows"] = String(r);
    cell.setAttribute("aria-label", `${c} columns by ${r} rows`);
    cell.addEventListener("mouseenter", () => previewLayout(c, r));
    cell.addEventListener("focus", () => previewLayout(c, r));
    cell.addEventListener("click", () => {
      applyLayout({ cols: c, rows: r });
      closeLayoutPicker();
    });
    layoutCells.push(cell);
  }
}
layoutGrid.style.gridTemplateColumns = `repeat(${MAX_COLS}, 22px)`;
layoutGrid.replaceChildren(...layoutCells);

function previewLayout(cols: number, rows: number): void {
  for (const cell of layoutCells) {
    const c = Number(cell.dataset["cols"]);
    const r = Number(cell.dataset["rows"]);
    cell.classList.toggle("on", c <= cols && r <= rows);
  }
  layoutLabel.textContent = `${cols} × ${rows}`;
}

function openLayoutPicker(): void {
  layoutPop.hidden = false;
  layoutBtn.setAttribute("aria-expanded", "true");
  previewLayout(layout.cols, layout.rows);
}

function closeLayoutPicker(): void {
  layoutPop.hidden = true;
  layoutBtn.setAttribute("aria-expanded", "false");
}

layoutBtn.addEventListener("click", () => {
  if (layoutPop.hidden) openLayoutPicker();
  else closeLayoutPicker();
});

// A click anywhere outside the picker closes it
document.addEventListener("mousedown", (e: MouseEvent) => {
  if (layoutPop.hidden) return;
  if (e.target instanceof Node && layoutWrap.contains(e.target)) return;
  closeLayoutPicker();
});

// ---------- Calibration ----------
let calTarget: { vp: Viewport; pixels: number } | null = null;

const calOpen = (): boolean => !calBackdrop.hidden;

function askCalibration(vp: Viewport, pixels: number): void {
  if (vp.hasFileSpacing()) {
    flashStatus("This image already has a calibrated pixel spacing in its file");
    return;
  }
  calTarget = { vp, pixels };
  calInfo.textContent = `The line you drew is ${num(pixels, 1)} pixels long. Enter its real length.`;
  calValue.value = "";
  calError.textContent = "";
  calBackdrop.hidden = false;
  calValue.focus();
}

function closeCalibration(): void {
  calBackdrop.hidden = true;
  calTarget = null;
}

function confirmCalibration(): void {
  if (!calTarget) return;
  const value = Number(calValue.value.replace(",", "."));
  if (!Number.isFinite(value) || value <= 0) {
    calError.textContent = "Enter a length greater than zero";
    return;
  }
  const mm = calUnit.value === "cm" ? value * 10 : value;
  const mmPerPixel = mm / calTarget.pixels;
  calTarget.vp.setCalibration(mmPerPixel);
  closeCalibration();
  flashStatus(`Calibrated: ${num(mmPerPixel, 3)} mm per pixel`);
}

calOk.addEventListener("click", confirmCalibration);
calCancel.addEventListener("click", closeCalibration);
calBackdrop.addEventListener("click", (e) => {
  if (e.target === calBackdrop) closeCalibration();
});
calValue.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Enter") {
    e.preventDefault();
    confirmCalibration();
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeCalibration();
  }
  e.stopPropagation(); // typing a number must not trigger viewer shortcuts
});

// ---------- Tools ----------
function setTool(next: ToolId): void {
  for (const vp of viewports) vp.cancelDraft(); // a half-drawn measurement does not survive a tool change
  tool = next;
  viewportsEl.dataset["tool"] = next;
  for (const b of toolButtons) {
    const on = b.dataset["tool"] === next;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  }
  syncMenu();
}

for (const b of toolButtons) {
  b.addEventListener("click", () => setTool(b.dataset["tool"] as ToolId));
}

function applyPreset(i: number): void {
  const p = PRESETS[i];
  if (p) active.setWindow(p.wl, p.ww, true);
}

// ---------- UI sync ----------
function syncMenu(): void {
  appMenu?.sync({
    tool,
    invert: active.invert,
    markers: markersOn,
    anonymize,
    overlay: overlayMode,
  });
}

function setPressed(btn: HTMLButtonElement, on: boolean): void {
  btn.classList.toggle("active", on);
  btn.setAttribute("aria-pressed", String(on));
}

function syncControls(): void {
  const vp = active;
  const n = vp.count;
  slider.max = String(Math.max(0, n - 1));
  slider.value = String(vp.index);
  slider.disabled = n <= 1;
  for (const el of [invertBtn, fitBtn, rotCcwBtn, rotCwBtn, flipHBtn, flipVBtn, tagsBtn]) {
    el.disabled = n === 0;
  }
  // Windowing does not apply to colour images
  for (const el of [resetBtn, presetSel]) el.disabled = n === 0 || vp.color;
  cineBtn.disabled = n <= 1;
  setIcon(cineBtn, vp.playing ? "pause" : "play");

  // The crosshair tool and the slab controls only exist while an MPR is shown
  const inMpr = mpr !== null;
  setPressed(mprBtn, inMpr);
  for (const el of [crossBtn, slabModeSel, slabThickSel]) el.hidden = !inMpr;
  slabThickSel.disabled = slabModeSel.value === "none";

  setPressed(invertBtn, vp.invert);
  setPressed(cineBtn, vp.playing);
  setPressed(flipHBtn, vp.orientation.flipH);
  setPressed(flipVBtn, vp.orientation.flipV);
  setPressed(markersBtn, markersOn);
  setPressed(anonBtn, anonymize);
  setPressed(syncScrollBtn, syncScroll);
  setPressed(syncWindowBtn, syncWindow);
  setLabel(layoutBtn, `${layout.cols} × ${layout.rows}`);
  setLabel(infoBtn, OVERLAY_LABEL[overlayMode]);
  setLabel(orientModeBtn, ORIENT_LABEL[orientMode]);
  setIcon(sliderPosBtn, sliderPos === "bottom" ? "panel-bottom" : "panel-right");

  syncMenu();
}

// A native range input has no vertical mode that works everywhere, so on the right
// it is rotated by 90 degrees and its length is set to the height of the bar.
function fitSlider(): void {
  slider.style.width =
    sliderPos === "right" ? `${Math.max(40, sliderBar.clientHeight - 24)}px` : "";
}

function applySliderPos(pos: SliderPosition, persist = true): void {
  sliderPos = pos;
  if (persist) update({ sliderPos });
  stageEl.dataset["slider"] = pos;
  fitSlider();
  syncControls();
}

function toggleSliderPos(): void {
  applySliderPos(sliderPos === "bottom" ? "right" : "bottom");
}

new ResizeObserver(() => fitSlider()).observe(sliderBar);

function setOverlay(mode: OverlayMode): void {
  overlayMode = mode;
  update({ overlay: mode });
  syncControls();
  refreshAllOverlays();
}

function cycleOverlay(): void {
  const next = OVERLAY_MODES[(OVERLAY_MODES.indexOf(overlayMode) + 1) % OVERLAY_MODES.length];
  setOverlay(next ?? "full");
}

function toggleOrientMode(): void {
  const next = ORIENT_MODES[(ORIENT_MODES.indexOf(orientMode) + 1) % ORIENT_MODES.length];
  orientMode = next ?? "standard";
  update({ orientMode });
  for (const vp of viewports) vp.refreshOrientMode();
  syncControls();
}

function toggleMarkers(): void {
  markersOn = !markersOn;
  update({ markers: markersOn });
  syncControls();
  refreshAllOverlays();
}

function toggleAnonymize(): void {
  anonymize = !anonymize;
  update({ anonymize });
  syncControls();
  refreshAllOverlays();
}

// ---------- Series list and thumbnails ----------
function renderSeriesList(): void {
  thumbCanvases.clear();
  seriesButtons.clear();
  seriesList.replaceChildren(
    ...seriesData.map((s) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.className = "series-item";
      seriesButtons.set(s.uid, btn);

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
      btn.addEventListener("click", () => showInActive(s));
      li.append(btn);
      return li;
    }),
  );
  updateHighlights();
}

// Strong highlight: the active viewport's series. Light outline: series on other views.
function updateHighlights(): void {
  const onScreen = new Set<string>();
  for (const vp of visible()) if (vp.series) onScreen.add(vp.series.uid);
  const activeUid = active.series?.uid;
  for (const [uid, btn] of seriesButtons) {
    btn.classList.toggle("active", uid === activeUid);
    btn.classList.toggle("shown", onScreen.has(uid) && uid !== activeUid);
  }
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

// ---------- Volume ----------
function volumeLines(uid: string): string[] {
  if (volumeBusy === uid) return ["Volume: building…"];
  if (!volume || volume.uid !== uid) return [];
  const v = volume.info;
  const sp = v.pixel_spacing;
  const voxel =
    sp && v.slice_spacing !== null
      ? `Voxel ${num(sp[1], 2)} × ${num(sp[0], 2)} × ${num(v.slice_spacing, 2)} mm`
      : "";
  const warn = [
    v.slice_spacing === null && "spacing unknown",
    !v.uniform && "uneven spacing",
    v.tilt_deg > 1 && `tilt ${num(v.tilt_deg, 1)}°`,
  ].filter(Boolean).join(", ");
  return compact([
    `Volume ${v.cols} × ${v.rows} × ${v.depth}`,
    voxel,
    warn && `(${warn})`,
  ]);
}

function applyVolumeLines(): void {
  for (const vp of viewports) {
    // The views of an MPR show the volume itself; its numbers would only repeat there
    vp.extraLines = vp.series && !vp.isReformat ? volumeLines(vp.series.uid) : [];
    vp.refreshOverlay();
  }
}

// The built volume of a series, building it first when needed. Null when it cannot be built.
async function ensureVolume(uid: string): Promise<VolumeInfo | null> {
  if (volume && volume.uid === uid) return volume.info;
  // The backend keeps one volume at a time, and the MPR is reading it
  if (mpr && mpr.series.uid !== uid) {
    flashStatus("Close the MPR before building the volume of another series");
    return null;
  }
  if (volumeBusy) {
    flashStatus("A volume is being built");
    return null;
  }
  volumeBusy = uid;
  applyVolumeLines();
  try {
    const info = await buildVolume(uid);
    // Ignore the result when other files have been opened in the meantime
    if (!seriesData.some((x) => x.uid === uid)) return null;
    volume = { uid, info };
    return info;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("superseded")) showError(err);
    return null;
  } finally {
    volumeBusy = null;
    applyVolumeLines();
  }
}

async function runBuildVolume(): Promise<void> {
  const s = active.series;
  if (!s || s.slice_count < 2) {
    flashStatus("A volume needs a series with at least 2 images");
    return;
  }
  await ensureVolume(s.uid);
}

// ---------- MPR ----------
const SLAB_MODES: SlabMode[] = ["none", "max", "min", "mean"];

function currentSlab(): Slab {
  const mode = SLAB_MODES.find((m) => m === slabModeSel.value) ?? "none";
  const mm = Number(slabThickSel.value);
  return { mode, mm: Number.isFinite(mm) && mm > 0 ? mm : 10 };
}

function applySlab(): void {
  syncControls();
  mpr?.setSlab(currentSlab());
}

async function enterMpr(series: SeriesInfo, info: VolumeInfo): Promise<void> {
  closeLayoutPicker();
  // Patient and study fields of the reformatted views come from the first image
  const base = await sliceCache.get(seriesSource(series.uid), 0).then(
    (c) => c.meta,
    () => null,
  );
  if (volume?.uid !== series.uid) return; // other files were opened meanwhile

  mprSaved = {
    layout: { ...layout },
    tool,
    // The first four views, whether they exist yet or not
    series: Array.from({ length: 4 }, (_, i) => viewports[i]?.series ?? null),
  };
  applyLayout({ cols: 2, rows: 2 }, false, false);

  const [a, c, s] = [viewports[0], viewports[1], viewports[2]];
  if (!a || !c || !s) return;
  const m = new Mpr({ panes: [a, c, s], series, volume: info, baseMeta: base }, currentSlab());
  mpr = m;

  void viewports[3]?.setSeries(series); // the original images stay in the fourth view
  activate(a);
  setTool("cross");
  afterAssignment();
  await m.start();
}

function exitMpr(restore: boolean): void {
  const m = mpr;
  if (!m) return;
  m.stop();
  mpr = null;
  const saved = mprSaved;
  mprSaved = null;

  if (restore && saved) {
    saved.series.forEach((s, i) => {
      void viewports[i]?.setSeries(s);
    });
    applyLayout(saved.layout, false);
    if (tool === "cross") setTool(saved.tool === "cross" ? "window" : saved.tool);
  } else if (tool === "cross") {
    setTool("window");
  }
  afterAssignment();
}

async function toggleMpr(): Promise<void> {
  if (mpr) {
    exitMpr(true);
    return;
  }
  if (mprBusy) return;
  const s = active.series;
  if (!s || s.slice_count < 2) {
    flashStatus("MPR needs a series with at least 2 images");
    return;
  }
  mprBusy = true;
  try {
    setStatus("Building volume…");
    const info = await ensureVolume(s.uid);
    if (statusEl.textContent === "Building volume…") setStatus("");
    if (info) await enterMpr(s, info);
  } finally {
    mprBusy = false;
  }
}

// ---------- Export ----------
// Exports the active view at native resolution, without overlays and measurements
async function exportImage(copy: boolean): Promise<void> {
  // Rendered before any await: the drawing buffer must be read in the same task
  const canvas = active.renderExport();
  if (!canvas) {
    flashStatus("No image to export");
    return;
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) {
    flashStatus("Could not encode the image");
    return;
  }

  try {
    if (copy) {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      flashStatus("Image copied to the clipboard");
      return;
    }
    const name = `image-${String(active.index + 1).padStart(3, "0")}.png`;
    const path = await save({
      defaultPath: name,
      filters: [{ name: "PNG image", extensions: ["png"] }],
    });
    if (typeof path !== "string") return;
    await savePng(path, new Uint8Array(await blob.arrayBuffer()));
    flashStatus(anonymize ? "Image saved (text burned into the pixels is not removed)" : "Image saved");
  } catch (err) {
    showError(err);
  }
}

// ---------- Loading ----------
async function showSeries(list: SeriesInfo[]): Promise<void> {
  exitMpr(false); // its volume and images belong to the old files
  thumbRun++; // cancels thumbnail loading for the previous selection
  thumbs.clear();
  sliceCache.clear(); // indices of the old files must not be served for the new ones
  seriesData = list;
  hasLoaded = true;
  volume = null;
  for (const vp of viewports) void vp.setSeries(null);
  renderSeriesList();

  activate(visible()[0] ?? first);
  // Thumbnails wait until the first images are on screen
  await Promise.all(fillEmptyViewports());
  setStatus("");
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

// ---------- Toolbar ----------
invertBtn.addEventListener("click", () => active.toggleInvert());
fitBtn.addEventListener("click", () => active.fit());
resetBtn.addEventListener("click", () => active.resetWindow());
rotCcwBtn.addEventListener("click", () => active.rotate(-1));
rotCwBtn.addEventListener("click", () => active.rotate(1));
flipHBtn.addEventListener("click", () => active.flip("h"));
flipVBtn.addEventListener("click", () => active.flip("v"));
orientModeBtn.addEventListener("click", toggleOrientMode);
cineBtn.addEventListener("click", () => active.togglePlay());
infoBtn.addEventListener("click", cycleOverlay);
markersBtn.addEventListener("click", toggleMarkers);
anonBtn.addEventListener("click", toggleAnonymize);
sliderPosBtn.addEventListener("click", toggleSliderPos);
syncScrollBtn.addEventListener("click", toggleSyncScroll);
syncWindowBtn.addEventListener("click", toggleSyncWindow);
mprBtn.addEventListener("click", () => void toggleMpr());

slabModeSel.addEventListener("change", () => {
  applySlab();
  slabModeSel.blur();
});
slabThickSel.addEventListener("change", () => {
  applySlab();
  slabThickSel.blur();
});

presetSel.addEventListener("change", () => {
  if (presetSel.value !== "") applyPreset(Number(presetSel.value));
  presetSel.value = "";
  presetSel.blur();
});

slider.addEventListener("input", () => active.goto(Number(slider.value)));
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

// ---------- Dialogs ----------
const dialog = createSettingsDialog({
  getBindings: () => bindings,
  onChange: (overrides) => {
    update({ keymap: overrides });
    rebuildKeymap();
    refreshPresetOptions();
    refreshTooltips();
  },
});

const tagsDialog = createTagsDialog({
  // The views of an MPR have no image number of their own; the crosshair's image is used
  context: () =>
    active.series
      ? { uid: active.series.uid, index: mpr?.owns(active) ? mpr.pos.k : active.index }
      : null,
  anonymize: () => anonymize,
});

const modalOpen = (): boolean => dialog.isOpen() || tagsDialog.isOpen() || calOpen();

function openSettings(): void {
  if (tagsDialog.isOpen()) tagsDialog.close();
  dialog.open();
}

function openTags(): void {
  if (!active.series) {
    flashStatus("Open a series first");
    return;
  }
  if (dialog.isOpen()) dialog.close();
  void tagsDialog.open();
}

settingsBtn.addEventListener("click", openSettings);
tagsBtn.addEventListener("click", openTags);

// ---------- Keyboard ----------
// One handler per action id; the keys that trigger them live in keymap.ts and the settings.
// Image, view and window actions apply to the active viewport.
const handlers: Record<string, () => void> = {
  "slice.prev": () => active.goto(active.index - 1),
  "slice.next": () => active.goto(active.index + 1),
  "slice.back10": () => active.goto(active.index - 10),
  "slice.fwd10": () => active.goto(active.index + 10),
  "slice.first": () => active.goto(0),
  "slice.last": () => active.goto(active.count - 1),
  "view.zoomIn": () => active.zoomBy(1.25),
  "view.zoomOut": () => active.zoomBy(0.8),
  "view.fit": () => active.fit(),
  "view.invert": () => active.toggleInvert(),
  "view.resetWindow": () => active.resetWindow(),
  "view.rotateCW": () => active.rotate(1),
  "view.rotateCCW": () => active.rotate(-1),
  "view.flipH": () => active.flip("h"),
  "view.flipV": () => active.flip("v"),
  "view.resetOrientation": () => active.resetOrientation(),
  "view.orientMode": toggleOrientMode,
  "tool.window": () => setTool("window"),
  "tool.pan": () => setTool("pan"),
  "tool.zoom": () => setTool("zoom"),
  "tool.scroll": () => setTool("scroll"),
  "tool.cross": () => {
    if (mpr) setTool("cross");
    else flashStatus("The crosshair tool works while an MPR is shown");
  },
  "tool.length": () => setTool("length"),
  "tool.angle": () => setTool("angle"),
  "tool.ellipse": () => setTool("ellipse"),
  "tool.rect": () => setTool("rect"),
  "tool.calibrate": () => setTool("calibrate"),
  "tool.aneurysm": () => setTool("aneurysm"),
  "calibration.clear": () => {
    active.setCalibration(null);
    flashStatus("Calibration removed");
  },
  "measure.undo": () => active.undoMeasurement(),
  "measure.clear": () => active.clearMeasurements(),
  "cine.toggle": () => active.togglePlay(),
  "cine.faster": () => active.changeFps(1.25),
  "cine.slower": () => active.changeFps(0.8),
  "ui.overlay": cycleOverlay,
  "ui.markers": toggleMarkers,
  "ui.anonymize": toggleAnonymize,
  "ui.slider": toggleSliderPos,
  "ui.tags": openTags,
  "ui.settings": openSettings,
  "volume.build": () => void runBuildVolume(),
  "mpr.toggle": () => void toggleMpr(),
  "sync.scroll": toggleSyncScroll,
  "sync.window": toggleSyncWindow,
  "export.save": () => void exportImage(false),
  "export.copy": () => void exportImage(true),
};
for (let i = 1; i <= PRESET_COUNT; i++) {
  handlers[`preset.${i}`] = () => applyPreset(i - 1);
}
for (const l of LAYOUT_PRESETS) {
  handlers[`layout.${l.cols}x${l.rows}`] = () => applyLayout(l);
}
for (const a of ACTIONS) {
  if (!handlers[a.id]) console.warn(`No handler for action ${a.id}`);
}

window.addEventListener("keydown", (e: KeyboardEvent) => {
  // While a dialog is open it owns the keyboard (including key capture)
  if (dialog.handleKey(e)) return;
  if (tagsDialog.handleKey(e)) return;

  if (e.key === "Enter" && active.finishAneurysmIfPending()) {
    e.preventDefault();
    return;
  }

  if (e.key === "Escape") {
    if (!layoutPop.hidden) {
      e.preventDefault();
      closeLayoutPicker();
      return;
    }
    if (active.cancelDraft()) {
      e.preventDefault();
      return;
    }
  }
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;

  const combo = comboFromEvent(e);
  if (!combo) return;
  const id = lookup.get(combo);
  if (!id) return;

  e.preventDefault();
  // Space would otherwise also activate a focused button
  if (e.code === "Space" && e.target instanceof HTMLElement) e.target.blur();
  // Toggles must not flip repeatedly while a key is held
  if (e.repeat && !ACTION_BY_ID.get(id)?.repeat) return;
  handlers[id]?.();
});

// ---------- Native menu ----------
// Menu actions are ignored while a dialog is open (it owns the keyboard)
const whenIdle = (fn: () => void) => (): void => {
  if (!modalOpen()) fn();
};

installMenu({
  appName: "DICOM Viewer",
  presetNames: PRESETS.map((p) => p.name),
  run: (id) => {
    if (modalOpen() && id !== "ui.settings" && id !== "ui.tags") {
      syncMenu(); // undo the native check toggle; the action itself is ignored
      return;
    }
    handlers[id]?.();
  },
  openFiles: whenIdle(() => openFilesBtn.click()),
  openFolder: whenIdle(() => openBtn.click()),
  setOverlay: (mode) => {
    if (modalOpen()) {
      syncMenu();
      return;
    }
    setOverlay(mode);
  },
})
  .catch((err: unknown) => {
    console.warn("Menu setup failed", err);
    return null;
  })
  .then((m) => {
    appMenu = m;
    syncMenu();
  });

// ---------- Init ----------
mountIcons(); // must run before the first syncControls call swaps icons
first.setActive(true);
setTool("window");
applySliderPos(sliderPos, false);
applyLayout(layout, false);
refreshEmptyMessages();
refreshPresetOptions();
refreshTooltips();
setTip(orientModeBtn, "Orientation: standard (radiological) or as stored in the file", "view.orientMode");
syncControls();
refreshAllOverlays();