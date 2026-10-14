import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { buildVolume, getThumbnail, openFiles, openFolder } from "./api";
import { byId } from "./dom";
import { compact, num } from "./format";
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
import { installMenu, type AppMenu } from "./menu";
import { createSettingsDialog } from "./settings-dialog";
import {
  LAYOUT_IDS,
  loadSettings,
  OVERLAY_MODES,
  saveSettings,
  type LayoutId,
  type OverlayMode,
  type Settings,
} from "./settings";
import type { SeriesInfo, VolumeInfo } from "./types";
import { syncedIndex, Viewport, type ToolId, type ViewportHost } from "./viewport";

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
const infoBtn = byId("info", HTMLButtonElement);
const markersBtn = byId("markers", HTMLButtonElement);
const anonBtn = byId("anonymize", HTMLButtonElement);
const settingsBtn = byId("settings-open", HTMLButtonElement);
const syncScrollBtn = byId("sync-scroll", HTMLButtonElement);
const syncWindowBtn = byId("sync-window", HTMLButtonElement);
const slider = byId("slider", HTMLInputElement);
const toolButtons = document.querySelectorAll<HTMLButtonElement>("#tools .tool");
const layoutButtons = document.querySelectorAll<HTMLButtonElement>("#layouts .layout");

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
const LAYOUTS: Record<LayoutId, { cols: number; rows: number }> = {
  "1x1": { cols: 1, rows: 1 },
  "2x1": { cols: 2, rows: 1 },
  "1x2": { cols: 1, rows: 2 },
  "2x2": { cols: 2, rows: 2 },
};
const LAYOUT_TIPS: Record<LayoutId, string> = {
  "1x1": "Single view",
  "2x1": "Two views side by side",
  "1x2": "Two views stacked",
  "2x2": "Four views",
};

let layout: LayoutId = settings.layout;
let overlayMode: OverlayMode = settings.overlay;
let anonymize = settings.anonymize;
let markersOn = settings.markers;
let syncScroll = settings.syncScroll;
let syncWindow = settings.syncWindow;
let tool: ToolId = "window";

let seriesData: SeriesInfo[] = [];
let hasLoaded = false;
let volume: { uid: string; info: VolumeInfo } | null = null;
let volumeBusy: string | null = null; // uid of the series being built
let appMenu: AppMenu | null = null;

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
};

// Tooltips and preset labels are generated from the keymap, so they never go stale
function refreshTooltips(): void {
  for (const b of toolButtons) {
    const t = b.dataset["tool"] ?? "";
    setTip(b, TOOL_TIPS[t] ?? t, `tool.${t}`);
  }
  for (const b of layoutButtons) {
    const id = LAYOUT_IDS.find((l) => l === b.dataset["layout"]);
    if (id) setTip(b, LAYOUT_TIPS[id], `layout.${id}`);
  }
  setTip(syncScrollBtn, "Scroll linked views together", "sync.scroll");
  setTip(syncWindowBtn, "Share window / level between views", "sync.window");
  setTip(invertBtn, "Invert", "view.invert");
  setTip(fitBtn, "Fit to window", "view.fit");
  setTip(resetBtn, "Reset window", "view.resetWindow");
  setTip(infoBtn, "Overlay detail: full / minimal / off", "ui.overlay");
  setTip(markersBtn, "Orientation markers and scale bars", "ui.markers");
  setTip(anonBtn, "Hide patient identifiers on screen", "ui.anonymize");
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
};

const first = new Viewport(host);
const viewports: Viewport[] = [first, new Viewport(host), new Viewport(host), new Viewport(host)];
let active: Viewport = first;
viewportsEl.append(...viewports.map((v) => v.el));

function cellCount(): number {
  const l = LAYOUTS[layout];
  return l.cols * l.rows;
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
  if (!syncScroll) return;
  for (const vp of visible()) {
    if (vp === src) continue;
    const idx = syncedIndex(src, vp);
    if (idx !== null) vp.goto(idx, false);
  }
}

function syncWindows(src: Viewport): void {
  if (!syncWindow) return;
  for (const vp of visible()) {
    if (vp !== src && vp.series) vp.setWindow(src.wl, src.ww, false);
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
function applyLayout(id: LayoutId, persist = true): void {
  layout = id;
  if (persist) update({ layout });

  const { cols, rows } = LAYOUTS[id];
  viewportsEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
  viewportsEl.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;
  viewportsEl.classList.toggle("multi", cols * rows > 1);
  viewports.forEach((vp, i) => vp.setVisible(i < cols * rows));

  const shown = visible();
  if (!shown.includes(active)) activate(shown[0] ?? first);
  void Promise.all(fillEmptyViewports());
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

// ---------- Tools ----------
function setTool(next: ToolId): void {
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
  for (const el of [invertBtn, fitBtn, resetBtn, presetSel]) el.disabled = n === 0;

  setPressed(invertBtn, vp.invert);
  setPressed(markersBtn, markersOn);
  setPressed(anonBtn, anonymize);
  setPressed(syncScrollBtn, syncScroll);
  setPressed(syncWindowBtn, syncWindow);
  for (const b of layoutButtons) setPressed(b, b.dataset["layout"] === layout);
  infoBtn.textContent = `Info: ${OVERLAY_LABEL[overlayMode]}`;

  syncMenu();
}

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
    vp.extraLines = vp.series ? volumeLines(vp.series.uid) : [];
    vp.refreshOverlay();
  }
}

async function runBuildVolume(): Promise<void> {
  if (volumeBusy) return;
  const s = active.series;
  if (!s || s.slice_count < 2) {
    flashStatus("A volume needs a series with at least 2 images");
    return;
  }
  volumeBusy = s.uid;
  applyVolumeLines();
  try {
    const info = await buildVolume(s.uid);
    // Ignore the result when other files have been opened in the meantime
    if (seriesData.some((x) => x.uid === s.uid)) volume = { uid: s.uid, info };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("superseded")) showError(err);
  } finally {
    volumeBusy = null;
    applyVolumeLines();
  }
}

// ---------- Loading ----------
async function showSeries(list: SeriesInfo[]): Promise<void> {
  thumbRun++; // cancels thumbnail loading for the previous selection
  thumbs.clear();
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
infoBtn.addEventListener("click", cycleOverlay);
markersBtn.addEventListener("click", toggleMarkers);
anonBtn.addEventListener("click", toggleAnonymize);
syncScrollBtn.addEventListener("click", toggleSyncScroll);
syncWindowBtn.addEventListener("click", toggleSyncWindow);

for (const b of layoutButtons) {
  b.addEventListener("click", () => {
    const id = LAYOUT_IDS.find((l) => l === b.dataset["layout"]);
    if (id) applyLayout(id);
  });
}

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

// ---------- Settings dialog and keyboard ----------
const dialog = createSettingsDialog({
  getBindings: () => bindings,
  onChange: (overrides) => {
    update({ keymap: overrides });
    rebuildKeymap();
    refreshPresetOptions();
    refreshTooltips();
  },
});

settingsBtn.addEventListener("click", () => dialog.open());

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
  "tool.window": () => setTool("window"),
  "tool.pan": () => setTool("pan"),
  "tool.zoom": () => setTool("zoom"),
  "tool.scroll": () => setTool("scroll"),
  "ui.overlay": cycleOverlay,
  "ui.markers": toggleMarkers,
  "ui.anonymize": toggleAnonymize,
  "ui.settings": () => dialog.open(),
  "volume.build": () => void runBuildVolume(),
  "sync.scroll": toggleSyncScroll,
  "sync.window": toggleSyncWindow,
};
for (let i = 1; i <= PRESET_COUNT; i++) {
  handlers[`preset.${i}`] = () => applyPreset(i - 1);
}
for (const id of LAYOUT_IDS) {
  handlers[`layout.${id}`] = () => applyLayout(id);
}
for (const a of ACTIONS) {
  if (!handlers[a.id]) console.warn(`No handler for action ${a.id}`);
}

window.addEventListener("keydown", (e: KeyboardEvent) => {
  // While the dialog is open it owns the keyboard (including key capture)
  if (dialog.handleKey(e)) return;
  if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;

  const combo = comboFromEvent(e);
  if (!combo) return;
  const id = lookup.get(combo);
  if (!id) return;

  e.preventDefault();
  // Toggles must not flip repeatedly while a key is held
  if (e.repeat && !ACTION_BY_ID.get(id)?.repeat) return;
  handlers[id]?.();
});

// ---------- Native menu ----------
// Menu actions are ignored while the settings dialog is open (it owns the keyboard)
const whenIdle = (fn: () => void) => (): void => {
  if (!dialog.isOpen()) fn();
};

installMenu({
  appName: "DICOM Viewer",
  presetNames: PRESETS.map((p) => p.name),
  run: (id) => {
    if (dialog.isOpen() && id !== "ui.settings") {
      syncMenu(); // undo the native check toggle; the action itself is ignored
      return;
    }
    handlers[id]?.();
  },
  openFiles: whenIdle(() => openFilesBtn.click()),
  openFolder: whenIdle(() => openBtn.click()),
  setOverlay: (mode) => {
    if (dialog.isOpen()) {
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
first.setActive(true);
setTool("window");
applyLayout(layout, false);
refreshEmptyMessages();
refreshPresetOptions();
refreshTooltips();
syncControls();
refreshAllOverlays();