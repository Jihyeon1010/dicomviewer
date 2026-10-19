import { getSeriesGeometry } from "./api";
import { cleanName, compact, fmtAge, fmtDate, fmtTime, num } from "./format";
import {
  edgeLabels,
  SCALE_BAR_HEIGHT,
  scaleBar,
  scaleBarPath,
  scaleBarPathVertical,
} from "./guides";
import {
  aneurysmLines,
  angleText,
  areaText,
  lengthText,
  roiLines,
  shapeAreaPx,
  type Spacing,
} from "./measure";
import { GLRenderer } from "./renderer";
import type { OverlayMode } from "./settings";
import { seriesSource, sliceCache, type SliceSource } from "./slice-cache";
import {
  cssTransform,
  imageToScreen,
  NO_ORIENT,
  orientedLabels,
  orientText,
  screenToImage,
  type Orient,
  type Pt,
  type Size,
  type ViewParams,
} from "./transform2d";
import type { SeriesGeometry, SeriesInfo, SliceData, SliceMeta } from "./types";

import { autoOrient, type OrientMode } from "./orient-auto";
import type { Plane } from "./types";

import { Angio, positionerText, PROJECTION_MODES, type ProjectionMode, type SubtractMode } from "./angio";

export type MeasureKind = "length" | "angle" | "ellipse" | "rect" | "aneurysm";
export type ToolId =
  | "window" | "pan" | "zoom" | "scroll" | "cross" | "rotate" | "maskshift" | "calibrate"
  | MeasureKind;
type DragMode = "window" | "pan" | "zoom" | "scroll";

export function isMeasureTool(t: ToolId): t is MeasureKind {
  return t === "length" || t === "angle" || t === "ellipse" || t === "rect" || t === "aneurysm";
}

/** A line across the whole image that marks where another plane cuts this view. */
export interface RefLine {
  axis: "x" | "y"; // "x": a vertical line at image x = pos; "y": a horizontal line at image y = pos
  pos: number;
  color: string;
}

export interface OverlayOptions {
  mode: OverlayMode;
  anonymize: boolean;
  markers: boolean;
}

// What a viewport needs from the application around it
export interface ViewportHost {
  tool(): ToolId;
  overlay(): OverlayOptions;
  activate(vp: Viewport): void;
  sliceChanged(vp: Viewport): void;  // the user moved to another image
  windowChanged(vp: Viewport): void; // the user changed window/level
  stateChanged(vp: Viewport): void;  // anything the toolbar shows
  pick(vp: Viewport, p: Pt): void;   // the crosshair tool was used at an image position
  orientMode(): OrientMode;
  // A view can fill the whole area while the others are hidden; a double click toggles that
  canMaximize(): boolean;
  toggleMaximize(vp: Viewport): void;
  // The user measured a known length with the calibration tool. The host asks for the real
  // length and calls setCalibration() with the answer.
  calibrate(vp: Viewport, pixels: number): void;
    // The rotate tool was used in this view; x and y are relative to the view
  rotate(vp: Viewport, phase: "down" | "move" | "up", x: number, y: number): void;
}

interface Drag {
  mode: DragMode;
  x: number; y: number;   // pointer start (client coordinates)
  ax: number; ay: number; // anchor point in viewport coordinates
  wl: number; ww: number;
  panX: number; panY: number; zoom: number;
  index: number;
}

// A pixel spacing set by the user from an object of known size (millimetres per pixel)
export interface Calibration {
  mmPerPixel: number;
}

// A finished measurement; points are in image coordinates, the text is fixed at creation
interface Measurement {
  kind: MeasureKind;
  pts: Pt[];
  lines: string[];
}

// A measurement being drawn; the last point follows the cursor
interface Draft {
  kind: MeasureKind;
  pts: Pt[];
}

const SVG_NS = "http://www.w3.org/2000/svg";
const MEASURE_COLOR = "#7dffb2";

// Views smaller than this cannot hold the full overlay
const SMALL_W = 360;
const SMALL_H = 260;

// Images fetched ahead of the shown one: in the direction of travel, and a few behind it
const PREFETCH_AHEAD = 8;
const PREFETCH_BEHIND = 2;
const MAX_SHIFT = 100; // largest mask shift in pixels

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

function div(className: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = className;
  return d;
}

function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

function svgWithPath(): { svg: SVGSVGElement; path: SVGPathElement } {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  svg.append(path);
  return { svg, path };
}

function buildUi(root: HTMLElement) {
  const canvas = document.createElement("canvas");
  canvas.className = "vp-canvas";

  const measure = document.createElementNS(SVG_NS, "svg");
  measure.setAttribute("class", "vp-measure");
  measure.setAttribute("aria-hidden", "true");

  const tl = div("overlay tl");
  const tr = div("overlay tr");
  const bl = div("overlay bl");
  const br = div("overlay br");
  const markerT = div("marker t");
  const markerB = div("marker b");
  const markerL = div("marker l");
  const markerR = div("marker r");

  const hLabel = div("scalebar-label");
  const h = svgWithPath();
  const hBar = div("scalebar h");
  hBar.append(hLabel, h.svg);

  const v = svgWithPath();
  const vLabel = div("scalebar-label");
  const vBar = div("scalebar v");
  vBar.append(v.svg, vLabel);

  const readout = div("vp-readout");
  const status = div("vp-status");
  const emptyTitle = div("vp-empty-title");
  const emptySub = div("vp-empty-sub");
  const empty = div("vp-empty");
  empty.append(emptyTitle, emptySub);

  root.append(
    canvas, measure, tl, tr, bl, br,
    markerT, markerB, markerL, markerR,
    hBar, vBar, readout, status, empty,
  );
  return {
    canvas, measure, readout, tl, tr, bl, br,
    markerT, markerB, markerL, markerR,
    hBar, hSvg: h.svg, hPath: h.path, hLabel,
    vBar, vSvg: v.svg, vPath: v.path, vLabel,
    status, emptyTitle, emptySub,
  };
}

type Ui = ReturnType<typeof buildUi>;

// ---------- Overlay text ----------

function patientLines(m: SliceMeta, anonymize: boolean): string[] {
  const demo = [m.patient_sex, fmtAge(m.patient_age)].filter(Boolean).join(" · ");
  if (anonymize) return compact(["Anonymized", demo]);
  return compact([
    cleanName(m.patient_name),
    m.patient_id && `ID ${m.patient_id}`,
    m.patient_birth_date && `DOB ${fmtDate(m.patient_birth_date)}`,
    demo,
  ]);
}

function studyLines(m: SliceMeta | null, seriesName: string, anonymize: boolean): string[] {
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

function imageLines(index: number, count: number, s: SliceData | null, m: SliceMeta | null): string[] {
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
    ? `Px ${num(m.pixel_spacing[1], 3)} × ${num(m.pixel_spacing[0], 3)} mm${m.spacing_is_imager ? " (detector)" : ""}`
    : "";
  return compact([
    count ? `Im ${index + 1} / ${count}` : "",
    s && `${s.cols} × ${s.rows}`,
    position,
    exposure,
    spacing,
  ]);
}

// ---------- Linking viewports ----------

function nearestIndex(positions: number[], p: number): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < positions.length; i++) {
    const d = Math.abs((positions[i] as number) - p);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * The image of `dst` that matches the image `src` currently shows, or null when the
 * two series cannot be related: the same series maps by image number; different series
 * need the same frame of reference and parallel planes, and map by position.
 */
export function syncedIndex(src: Viewport, dst: Viewport): number | null {
  if (!src.series || !dst.series) return null;
  if (src.series.uid === dst.series.uid) return src.index;

  const a = src.geometry;
  const b = dst.geometry;
  if (!a?.positions || !b?.positions || !a.normal || !b.normal) return null;
  if (a.frame_of_reference === "" || a.frame_of_reference !== b.frame_of_reference) return null;

  const parallel = a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2];
  if (parallel < 0.99) return null;

  const p = a.positions[src.index];
  return p === undefined ? null : nearestIndex(b.positions, p);
}

// ---------- Viewport ----------

export class Viewport {
  readonly el: HTMLDivElement;
  series: SeriesInfo | null = null;
  count = 0;
  index = 0;
  wl = 40;
  ww = 400;
  invert = false;
  fps = 10; // cine playback rate
  geometry: SeriesGeometry | null = null;
  extraLines: string[] = []; // appended to the bottom-left overlay (volume info)

  private readonly host: ViewportHost;
  private readonly ui: Ui;
  private renderer: GLRenderer | null = null;
  private source: SliceSource | null = null; // null: the plain images of `series`
  private current: SliceData | null = null;
  private meta: SliceMeta | null = null;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private orient: Orient = { ...NO_ORIENT };
  private plane: Plane = "axial"; // which plane this view shows; decides the standard orientation
  private baseOrient: Orient = { ...NO_ORIENT }; // the automatic part of the orientation
  private autoPending = true; // the automatic orientation is applied once per content
  private autoFit = true; // keep the image fitted until the user zooms or pans
  private firstLoad = true; // apply the file's default WL/WW only once per series
  private fetchToken = 0;
  private loading = false;
  private drawQueued = false;
  private drag: Drag | null = null;
  private wheelAcc = 0;
  private dir: 1 | -1 = 1; // direction of the last move, used to prefetch ahead
  private cineRaf = 0; // requestAnimationFrame id while playing, 0 otherwise
  private cineLast = 0;
  private measurements = new Map<string, Measurement[]>(); // keyed by source and image
  private draft: Draft | null = null;
  private measuring = false; // mouse button held while drawing a drag-style measurement
  private calibration: Calibration | null = null;
  private calibrating = false; // the drag in progress measures a calibration length
  private rotating = false; // mouse button held with the rotate tool
  private angio: Angio | null = null;
  private shifting: { p0: Pt; dx0: number; dy0: number } | null = null;
  private windowPending = false; // apply the default window of the next image
  private loop: { from: number; to: number } | null = null;
  private pingPong = false;
  private cineDir: 1 | -1 = 1;
  private bookmarks = new Set<number>();
  private aneurysmPts: Pt[] = []; // clicks collected so far for the aneurysm template
  private refLines: RefLine[] = [];
  private crossing = false; // mouse button held with the crosshair tool
  private crossRaf = 0;
  private crossPt: { x: number; y: number } | null = null;

  /** True when the shown image is in colour; windowing does not apply to those. */
  get color(): boolean {
    return this.current?.samples === 3;
  }

  /** True when this view shows a reformatted plane instead of the images of a series. */
  get isReformat(): boolean {
    return this.source !== null;
  }

  get playing(): boolean {
    return this.cineRaf !== 0;
  }

  /** True while an image is being fetched. */
  get busy(): boolean {
    return this.loading;
  }

  /** Where the middle of the image is on screen, in the coordinates of this view. */
  imageCenterOnScreen(): Pt | null {
    const s = this.current;
    return s ? this.toScreen({ x: s.cols / 2, y: s.rows / 2 }) : null;
  }

  get orientation(): Orient {
    return this.orient;
  }

  constructor(host: ViewportHost) {
    this.host = host;
    this.el = document.createElement("div");
    this.el.className = "vp empty";
    this.ui = buildUi(this.el);

    try {
      this.renderer = new GLRenderer(this.ui.canvas, () => this.requestDraw());
    } catch (err) {
      this.showError(err);
    }

    new ResizeObserver(() => {
      if (this.autoFit && this.current) this.fitView();
      this.refreshOverlay();
    }).observe(this.el);

    this.bindMouse();
  }

  // ---------- Content ----------

  // Forgets the shown content; the caller loads the first image afterwards
  private reset(series: SeriesInfo | null, source: SliceSource | null, count: number, index: number): void {
    this.stopPlay();
    sliceCache.cancel(this);
    this.fetchToken++; // drops responses that are still in flight for the old content
    this.loading = false;
    this.series = series;
    this.source = source;
    this.count = count;
    this.index = clamp(index, 0, Math.max(0, count - 1));
    this.dir = 1;
    this.fps = 10;
    this.firstLoad = true;
    this.autoFit = true;
    this.current = null;
    this.meta = null;
    this.geometry = null;
    this.extraLines = [];
    this.orient = { ...NO_ORIENT };
    this.baseOrient = { ...NO_ORIENT };
    this.autoPending = true;
    this.draft = null;
    this.measuring = false;
    this.crossing = false;
    this.rotating = false;
    this.angio = series && !source ? new Angio(series.uid, series.slice_count) : null;
    this.shifting = null;
    this.windowPending = false;
    this.loop = null;
    this.pingPong = false;
    this.cineDir = 1;
    this.bookmarks.clear();
    this.refLines = [];
    if (series === null) this.measurements.clear();
    this.ui.readout.textContent = "";
    this.setStatus("");
    this.el.classList.toggle("empty", series === null);
    this.refreshOverlay();
    this.host.stateChanged(this);
  }

  /** Shows a series (or clears the viewport). Resolves once the first image is loaded. */
  setSeries(series: SeriesInfo | null): Promise<void> {
    this.plane ="axial";
    this.reset(series, null, series?.slice_count ?? 0, 0);
    if (!series) return Promise.resolve();
    void this.loadGeometry(series.uid);
    return this.loadSlice();
  }

  /**
   * Shows a reformatted view of the volume of `series`. `count` is the number of positions
   * the view can scroll through. Resolves once the first image is loaded.
   */
  setReformat(
    series: SeriesInfo,
    source: SliceSource,
    count: number,
    index: number,
    plane: Plane,
  ): Promise<void> {
    this.plane = plane;
    this.reset(series, source, count, index);
    return this.loadSlice();
  }

  /**
   * Swaps the images of a reformatted view and keeps zoom and window. The number of
   * positions and the shown position can change with the new source.
   */
  replaceSource(source: SliceSource, count?: number, index?: number): void {
    if (!this.source) return;
    this.source = source;
    if (count !== undefined) this.count = Math.max(1, count);
    if (index !== undefined) this.index = clamp(index, 0, this.count - 1);
    sliceCache.cancel(this);
    this.refreshOverlay();
    this.host.stateChanged(this);
    void this.loadSlice();
  }

  /** Reference lines of other planes, drawn across the image. */
  setRefLines(lines: RefLine[]): void {
    this.refLines = lines;
    this.updateMeasurements();
  }

  setEmptyMessage(title: string, sub: string): void {
    this.ui.emptyTitle.textContent = title;
    this.ui.emptySub.textContent = sub;
  }

  setActive(on: boolean): void {
    this.el.classList.toggle("active", on);
  }

  setVisible(on: boolean): void {
    this.el.hidden = !on;
    if (on) {
      this.requestDraw();
      this.planPrefetch();
    } else {
      this.stopPlay();
      sliceCache.cancel(this); // hidden views do not need images ahead of time
    }
  }

  private async loadGeometry(uid: string): Promise<void> {
    try {
      const g = await getSeriesGeometry(uid);
      if (this.series?.uid === uid && !this.source) this.geometry = g;
    } catch (err) {
      // Linking with other viewports is simply unavailable without geometry
      console.warn(`Geometry unavailable for series ${uid}`, err);
    }
  }

  private activeSource(): SliceSource | null {
    if (this.source) return this.source;
    if (!this.series) return null;
    return this.angio?.source() ?? seriesSource(this.series.uid);
  }

    private async loadSlice(): Promise<void> {
    const src = this.activeSource();
    if (!src || this.count === 0) return;
    const token = ++this.fetchToken;
    this.loading = true;
    // Subtraction and projections can take a moment; say so
    const slow = window.setTimeout(() => {
      if (token === this.fetchToken) this.setStatus("Working…");
    }, 600);
    try {
      // From the shared cache: an image that was prefetched resolves immediately.
      // Metadata is optional; a failure there is already turned into null by the source.
      const { slice, meta: m } = await sliceCache.get(src, this.index);
      if (token !== this.fetchToken) return; // a newer request superseded this one

      const dimsChanged =
        !this.current || this.current.rows !== slice.rows || this.current.cols !== slice.cols;
      this.current = slice;
      this.meta = m;
      this.renderer?.upload(slice);

      if (this.autoPending) {
        this.autoPending = false;
        this.applyAutoOrient(m);
      }
      if (this.firstLoad || this.windowPending) {
        if (slice.defaultWl !== null && slice.defaultWw !== null) {
          this.wl = slice.defaultWl;
          this.ww = slice.defaultWw;
        }
        this.windowPending = false;
      }
      if (this.firstLoad) {
        if (m?.cine_fps) this.fps = clamp(m.cine_fps, 1, 60);
        this.firstLoad = false;
      }
      if (dimsChanged) {
        // Resizing clears the drawing buffer, so draw right after
        this.ui.canvas.width = slice.cols;
        this.ui.canvas.height = slice.rows;
        if (this.autoFit) this.fitView();
        else this.applyTransform();
      }
      this.setStatus("");
      this.draw();
      this.host.stateChanged(this); // grayscale or colour decides which controls apply
      this.planPrefetch();
    } catch (err) {
      if (token === this.fetchToken) {
        this.stopPlay();
        this.showError(err);
      }
    } finally {
      window.clearTimeout(slow);
      if (token === this.fetchToken) this.loading = false;
    }
  }

  // Asks the cache to load the images around the shown one in the background
  private planPrefetch(): void {
    const src = this.activeSource();
    if (!src || !this.current || this.el.hidden) return;
    const wanted: number[] = [];
    for (let k = 1; k <= PREFETCH_AHEAD; k++) wanted.push(this.index + this.dir * k);
    for (let k = 1; k <= PREFETCH_BEHIND; k++) wanted.push(this.index - this.dir * k);
    sliceCache.plan(
      this,
      src,
      wanted.filter((i) => i >= 0 && i < this.count),
    );
  }

  // ---------- Navigation and window ----------

  goto(next: number, notify = true, fromCine = false): void {
    if (this.count === 0) return;
    const clamped = Math.max(0, Math.min(this.count - 1, next));
    if (clamped === this.index) return;
    if (!fromCine) this.stopPlay(); // scrolling by hand pauses playback
    this.draft = null; // measurements belong to one image
    this.measuring = false;
    this.dir = clamped > this.index ? 1 : -1;
    this.index = clamped;
    this.refreshOverlay();
    this.host.stateChanged(this);
    if (notify) this.host.sliceChanged(this);
    void this.loadSlice();
  }

  setWindow(wl: number, ww: number, notify: boolean): void {
    if (this.color) return; // windowing does not apply to colour images
    this.wl = wl;
    this.ww = Math.max(1, ww);
    this.requestDraw();
    if (notify) this.host.windowChanged(this);
  }

  resetWindow(): void {
    if (this.color) return;
    const s = this.current;
    if (s && s.defaultWl !== null && s.defaultWw !== null) {
      this.setWindow(s.defaultWl, s.defaultWw, true);
    } else {
      this.setWindow(40, 400, true);
    }
  }

  toggleInvert(): void {
    this.invert = !this.invert;
    this.requestDraw();
    this.host.stateChanged(this);
  }

  // ---------- Cine ----------

  togglePlay(): void {
    if (this.playing) this.stopPlay();
    else this.startPlay();
  }

  startPlay(): void {
    if (this.playing || this.count < 2) return;
    this.cancelDraft();
    this.cineLast = performance.now();
    this.cineRaf = requestAnimationFrame(this.tick);
    this.refreshOverlay();
    this.host.stateChanged(this);
  }

  stopPlay(): void {
    if (!this.playing) return;
    cancelAnimationFrame(this.cineRaf);
    this.cineRaf = 0;
    this.refreshOverlay();
    this.host.stateChanged(this);
  }

  changeFps(factor: number): void {
    this.fps = clamp(this.fps * factor, 1, 60);
    this.refreshOverlay();
  }

  // Advances only when the previous image has arrived, so requests never pile up
  private tick = (now: number): void => {
    if (!this.playing) return;
    if (!this.loading && this.count > 1 && now - this.cineLast >= 1000 / this.fps) {
      this.cineLast = now;
      this.goto(this.nextCineIndex(), true, true);
    }
    if (!this.playing) return; // stopped while advancing
    this.cineRaf = requestAnimationFrame(this.tick);
  };

  // The next frame of the loop (or of the whole series), forwards or back and forth
  private nextCineIndex(): number {
    const lo = this.loop ? this.loop.from : 0;
    const hi = this.loop ? Math.min(this.loop.to, this.count - 1) : this.count - 1;
    if (hi <= lo) return lo;
    let next = this.index + this.cineDir;
    if (this.pingPong) {
      if (next > hi) {
        this.cineDir = -1;
        next = hi - 1;
      } else if (next < lo) {
        this.cineDir = 1;
        next = lo + 1;
      }
    } else {
      this.cineDir = 1;
      if (next > hi || next < lo) next = lo;
    }
    return clamp(next, lo, hi);
  }

  // ---------- Angiography: subtraction, projection, loop, bookmarks ----------

  /** A series of several grayscale XA or RF frames: the subtraction controls apply. */
  get angioCandidate(): boolean {
    const m = this.meta?.modality ?? "";
    return (
      !this.source &&
      this.angio !== null &&
      (this.series?.slice_count ?? 0) >= 2 &&
      this.current?.samples === 1 &&
      (m === "XA" || m === "RF")
    );
  }

  get dsaOn(): boolean {
    return this.angio?.dsa ?? false;
  }

  get subtractMode(): SubtractMode {
    return this.angio?.mode ?? "linear";
  }

  get projection(): ProjectionMode {
    return this.angio?.proj ?? "off";
  }

  /** The value of the mask selector that matches the current mask. */
  get maskChoice(): string {
    const m = this.angio?.mask;
    if (!m) return "1";
    return m.from === 0 && [1, 3, 5, 10].includes(m.to + 1) ? String(m.to + 1) : "cur";
  }

  get loopRange(): { from: number; to: number } | null {
    return this.loop;
  }

  get pingPongOn(): boolean {
    return this.pingPong;
  }

  get bookmarked(): boolean {
    return this.bookmarks.has(this.index);
  }

  async setDsa(on: boolean): Promise<void> {
    const a = this.angio;
    if (!a || !this.series || !this.angioCandidate || on === a.dsa) return;
    // Linear detector signals are subtracted in the log domain; other data directly
    if (on && !a.modeChosen) a.mode = this.meta?.intensity_relation === "LIN" ? "log" : "linear";
    a.dsa = on;
    if (!on) {
      a.dx = 0;
      a.dy = 0;
    }
    await this.applyAngio(true);
  }

  setMaskFirst(n: number): void {
    const a = this.angio;
    if (!a) return;
    a.mask = { from: 0, to: Math.max(0, n - 1) };
    a.clampMask();
    if (a.dsa) void this.applyAngio(false);
  }

  setMaskHere(): void {
    const a = this.angio;
    if (!a || !a.dsa) return;
    a.mask = { from: this.index, to: this.index };
    void this.applyAngio(false);
  }

  setSubtractMode(mode: SubtractMode): void {
    const a = this.angio;
    if (!a) return;
    a.mode = mode;
    a.modeChosen = true;
    if (a.dsa) void this.applyAngio(true); // the units change, so does the window
  }

  setShift(dx: number, dy: number): void {
    const a = this.angio;
    if (!a || !a.dsa) return;
    const nx = clamp(Math.round(dx), -MAX_SHIFT, MAX_SHIFT);
    const ny = clamp(Math.round(dy), -MAX_SHIFT, MAX_SHIFT);
    if (nx === a.dx && ny === a.dy) return;
    a.dx = nx;
    a.dy = ny;
    void this.applyAngio(false);
  }

  shiftMask(ddx: number, ddy: number): void {
    const a = this.angio;
    if (a?.dsa) this.setShift(a.dx + ddx, a.dy + ddy);
  }

  resetShift(): void {
    this.setShift(0, 0);
  }

  setProjection(mode: ProjectionMode): void {
    const a = this.angio;
    if (!a || a.proj === mode) return;
    a.proj = mode;
    void this.applyAngio(false);
  }

  cycleProjection(): void {
    const a = this.angio;
    if (!a || !this.angioCandidate) return;
    const next = PROJECTION_MODES[(PROJECTION_MODES.indexOf(a.proj) + 1) % PROJECTION_MODES.length];
    this.setProjection(next ?? "off");
  }

  // Shows the images of the current subtraction and projection settings
  private async applyAngio(resetWindow: boolean): Promise<void> {
    const a = this.angio;
    const series = this.series;
    if (!a || !series) return;
    this.stopPlay();

    let failure: unknown = null;
    try {
      await a.prepare();
    } catch (err) {
      a.dsa = false; // fall back to the plain frames
      a.dx = 0;
      a.dy = 0;
      failure = err;
    }
    if (this.angio !== a) return; // other content was loaded while preparing

    const projecting = a.proj !== "off";
    this.count = projecting ? 1 : series.slice_count;
    this.index = projecting ? 0 : clamp(this.index, 0, this.count - 1);
    if (resetWindow) this.windowPending = true;
    sliceCache.cancel(this);
    this.refreshOverlay();
    this.host.stateChanged(this);
    await this.loadSlice();
    if (failure) this.showError(failure);
  }

  markIn(): void {
    if (this.count < 2) return;
    const to = this.loop?.to ?? this.count - 1;
    this.loop = { from: this.index, to: Math.max(to, this.index) };
    this.refreshOverlay();
    this.host.stateChanged(this);
  }

  markOut(): void {
    if (this.count < 2) return;
    const from = this.loop?.from ?? 0;
    this.loop = { from: Math.min(from, this.index), to: this.index };
    this.refreshOverlay();
    this.host.stateChanged(this);
  }

  clearLoop(): void {
    this.loop = null;
    this.refreshOverlay();
    this.host.stateChanged(this);
  }

  togglePingPong(): void {
    this.pingPong = !this.pingPong;
    this.cineDir = 1;
    this.refreshOverlay();
    this.host.stateChanged(this);
  }

  toggleBookmark(): void {
    if (this.count < 2) return;
    if (!this.bookmarks.delete(this.index)) this.bookmarks.add(this.index);
    this.refreshOverlay();
    this.host.stateChanged(this);
  }

  /** Jumps to the next (1) or previous (-1) bookmark, wrapping around. */
  gotoBookmark(dir: 1 | -1): void {
    const list = [...this.bookmarks].sort((x, y) => x - y);
    if (list.length === 0) return;
    const next =
      dir === 1
        ? (list.find((i) => i > this.index) ?? list[0])
        : ([...list].reverse().find((i) => i < this.index) ?? list[list.length - 1]);
    if (next !== undefined) this.goto(next);
  }

  // Lines about the angiographic series for the bottom-left overlay
  private angioLines(): string[] {
    const m = this.meta;
    const a = this.angio;
    const out: string[] = [];

    const pos = positionerText(m?.positioner_primary ?? null, m?.positioner_secondary ?? null);
    if (pos) out.push(pos);
    if (m?.frame_time_ms && !(a && a.proj !== "off")) {
      out.push(`t ${num((this.index * m.frame_time_ms) / 1000, 2)} s`);
    }
    if (a?.dsa) {
      const range =
        a.mask.to > a.mask.from ? `${a.mask.from + 1}–${a.mask.to + 1}` : `${a.mask.from + 1}`;
      const shift = a.dx || a.dy ? ` · shift ${a.dx}, ${a.dy}` : "";
      out.push(`DSA ${a.mode} · mask ${range}${shift}`);
    }
    if (a && a.proj !== "off") out.push(`Projection: ${a.proj} over time`);
    if (this.loop) {
      out.push(`Loop ${this.loop.from + 1}–${this.loop.to + 1}${this.pingPong ? " · ping-pong" : ""}`);
    } else if (this.pingPong) {
      out.push("Ping-pong");
    }
    if (this.bookmarks.size > 0) {
      const list = [...this.bookmarks].sort((x, y) => x - y).map((i) => i + 1);
      const more = list.length > 8 ? "…" : "";
      out.push(`${this.bookmarks.has(this.index) ? "★ " : ""}Bookmarks ${list.slice(0, 8).join(", ")}${more}`);
    }
    return out;
  }

  // ---------- Orientation ----------

  rotate(dir: 1 | -1): void {
    // On a mirrored image a clockwise turn on screen is a counterclockwise turn of the stored rotation
    const mirrored = this.orient.flipH !== this.orient.flipV;
    const step = mirrored ? -dir : dir;
    this.reorient({ ...this.orient, rot: (this.orient.rot + step + 4) % 4 });
  }

  flip(axis: "h" | "v"): void {
    this.reorient(
      axis === "h"
        ? { ...this.orient, flipH: !this.orient.flipH }
        : { ...this.orient, flipV: !this.orient.flipV },
    );
  }

  // Turns or mirrors the image about a point that stays where it is on screen: the crosshair
  // of an MPR view, otherwise the middle of a zoomed or panned view. A fitted view is fitted
  // again; the point is then put back, so the zoom may fit the new orientation but nothing orbits.
  private reorient(next: Orient): void {
    const r = this.el.getBoundingClientRect();
    let hold: { p: Pt; s: Pt } | null = null;
    if (this.current && r.width > 0 && r.height > 0) {
      const cross = this.crosshairPoint();
      if (cross) {
        hold = { p: cross, s: this.toScreen(cross) };
      } else if (!this.autoFit) {
        const s = { x: r.width / 2, y: r.height / 2 };
        hold = { p: this.toImage(s.x, s.y), s };
      }
    }
    this.orient = next;
    if (this.autoFit && this.current) this.fitView();
    if (hold) {
      const t = this.toScreen(hold.p);
      this.panX += hold.s.x - t.x;
      this.panY += hold.s.y - t.y;
    }
    this.orientChanged(false);
  }

  // The crosshair of an MPR view as an image position
  private crosshairPoint(): Pt | null {
    if (!this.isReformat) return null;
    const x = this.refLines.find((l) => l.axis === "x");
    const y = this.refLines.find((l) => l.axis === "y");
    return x && y ? { x: x.pos, y: y.pos } : null;
  }

  // The orientation that the current mode asks for; the images of a series all share it
  private applyAutoOrient(meta: SliceMeta | null): void {
    this.baseOrient =
      this.host.orientMode() === "standard"
        ? autoOrient(edgeLabels(meta), this.plane)
        : { ...NO_ORIENT };
    this.orient = { ...this.baseOrient };
  }

  /** The mode changed: orientation goes back to what the mode gives, user turns are dropped. */
  refreshOrientMode(): void {
    if (!this.current) return;
    this.applyAutoOrient(this.meta);
    this.orientChanged();
  }

  resetOrientation(): void {
    this.reorient({ ...this.baseOrient });
  }

  private orientChanged(refit = true): void {
    if (refit && this.autoFit && this.current) this.fitView();
    else this.applyTransform();
    this.refreshOverlay();
    this.host.stateChanged(this);
  }

  // ---------- View transform ----------

  private size(): Size {
    const s = this.current;
    return { cols: s?.cols ?? 1, rows: s?.rows ?? 1 };
  }

  private viewParams(): ViewParams {
    return { zoom: this.zoom, panX: this.panX, panY: this.panY };
  }

  private toScreen(p: Pt): Pt {
    return imageToScreen(p, this.size(), this.viewParams(), this.orient);
  }

  private toImage(sx: number, sy: number): Pt {
    return screenToImage({ x: sx, y: sy }, this.size(), this.viewParams(), this.orient);
  }

  private applyTransform(): void {
    this.ui.canvas.style.transform = this.current
      ? cssTransform(this.size(), this.viewParams(), this.orient)
      : "";
  }

  private fitView(): void {
    const s = this.current;
    if (!s) return;
    const r = this.el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    // A quarter turn swaps the displayed width and height
    const odd = this.orient.rot % 2 === 1;
    const dw = odd ? s.rows : s.cols;
    const dh = odd ? s.cols : s.rows;
    this.zoom = Math.min(r.width / dw, r.height / dh);
    // The image center stays fixed under rotation and mirroring
    this.panX = r.width / 2 - (this.zoom * s.cols) / 2;
    this.panY = r.height / 2 - (this.zoom * s.rows) / 2;
    this.autoFit = true;
    this.applyTransform();
  }

  fit(): void {
    this.fitView();
    this.refreshOverlay();
  }

  private zoomAt(factor: number, cx: number, cy: number): void {
    const z2 = clamp(this.zoom * factor, 0.05, 50);
    const k = z2 / this.zoom;
    this.panX = cx - (cx - this.panX) * k;
    this.panY = cy - (cy - this.panY) * k;
    this.zoom = z2;
    this.autoFit = false;
    this.applyTransform();
    this.refreshOverlay();
  }

  zoomBy(factor: number): void {
    const r = this.el.getBoundingClientRect();
    this.zoomAt(factor, r.width / 2, r.height / 2);
  }

  // ---------- Rendering ----------

  private requestDraw(): void {
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      this.draw();
    });
  }

  // Window/level, inversion and rescaling all run in the fragment shader,
  // so a redraw only updates uniforms and never touches the pixel data.
  private draw(): void {
    if (!this.current || !this.renderer || this.el.hidden) return;
    this.renderer.draw({ wl: this.wl, ww: this.ww, invert: this.invert });
    this.refreshOverlay();
  }

  /**
   * The image at its native resolution with the current window, inversion, rotation and
   * mirroring, without overlays or measurements. Null when there is nothing to export.
   */
  renderExport(): HTMLCanvasElement | null {
    const s = this.current;
    if (!s || !this.renderer) return null;
    // Draw and read back in the same task: the drawing buffer is cleared once it is composited
    this.renderer.draw({ wl: this.wl, ww: this.ww, invert: this.invert });

    const odd = this.orient.rot % 2 === 1;
    const out = document.createElement("canvas");
    out.width = odd ? s.rows : s.cols;
    out.height = odd ? s.cols : s.rows;
    const ctx = out.getContext("2d");
    if (!ctx) return null;
    ctx.translate(out.width / 2, out.height / 2);
    ctx.scale(this.orient.flipH ? -1 : 1, this.orient.flipV ? -1 : 1);
    ctx.rotate((this.orient.rot * Math.PI) / 2);
    ctx.drawImage(this.ui.canvas, -s.cols / 2, -s.rows / 2);
    return out;
  }

  // ---------- Overlay ----------

  refreshOverlay(): void {
    this.el.classList.toggle("small", this.isSmall());
    this.updateText();
    this.updateGuides();
    this.updateMeasurements();
  }

  private isSmall(): boolean {
    return this.el.clientWidth < SMALL_W || this.el.clientHeight < SMALL_H;
  }

  private updateText(): void {
    const { tl, tr, bl, br } = this.ui;
    const o = this.host.overlay();
    const series = this.series;
    if (!series || o.mode === "off") {
      for (const el of [tl, tr, bl, br]) el.textContent = "";
      return;
    }

    const s = this.current;
    const m = this.meta;
    // Small views fall back to the minimal overlay
    const full = o.mode === "full" && !this.isSmall();
    tl.textContent = full && m ? patientLines(m, o.anonymize).join("\n") : "";
    tr.textContent = full ? studyLines(m, series.description, o.anonymize).join("\n") : "";
    const calibLine = this.calibration
      ? [`Px ${num(this.calibration.mmPerPixel, 3)} × ${num(this.calibration.mmPerPixel, 3)} mm (calibrated)`]
      : [];
    bl.textContent = full
      ? [...imageLines(this.index, this.count, s, m), ...this.angioLines(), ...calibLine, ...this.extraLines].join("\n")
      : this.count
        ? `Im ${this.index + 1} / ${this.count}`
        : "";

    const lines: string[] = [];
    if (this.playing) lines.push(`Cine ${Math.round(this.fps)} fps`);
    const ot = orientText(this.orient);
    if (ot) lines.push(ot);
    if (s && s.samples === 1) {
      lines.push(
        `WL ${Math.round(this.wl)}  WW ${Math.round(this.ww)}${this.invert ? "  (inverted)" : ""}`,
      );
    } else if (s && this.invert) {
      lines.push("(inverted)");
    }
    if (s) lines.push(`Zoom ${Math.round(this.zoom * 100)}%`);
    br.textContent = lines.join("\n");
  }

  // Orientation markers and scale bars. Independent of the text overlay mode.
  private updateGuides(): void {
    const ui = this.ui;
    const show = this.host.overlay().markers && this.current !== null;

    const base = show ? edgeLabels(this.meta) : null;
    const labels = base ? orientedLabels(base, this.orient) : null;
    ui.markerT.textContent = labels?.top ?? "";
    ui.markerB.textContent = labels?.bottom ?? "";
    ui.markerL.textContent = labels?.left ?? "";
    ui.markerR.textContent = labels?.right ?? "";

    // A quarter turn makes the screen's horizontal axis the image's row direction
    const cal = this.calibration?.mmPerPixel ?? 0;
    const colSpacing = cal > 0 ? cal : (this.meta?.pixel_spacing?.[1] ?? 0);
    const rowSpacing = cal > 0 ? cal : (this.meta?.pixel_spacing?.[0] ?? 0);
    const swap = this.orient.rot % 2 === 1;
    const hSpacing = swap ? rowSpacing : colSpacing;
    const vSpacing = swap ? colSpacing : rowSpacing;

    const bar = show && hSpacing > 0 ? scaleBar(this.zoom / hSpacing) : null;
    ui.hBar.classList.toggle("on", bar !== null);
    if (bar) {
      ui.hSvg.setAttribute("width", String(bar.px + 2));
      ui.hSvg.setAttribute("height", String(SCALE_BAR_HEIGHT));
      ui.hPath.setAttribute("d", scaleBarPath(bar));
      ui.hLabel.textContent = bar.label;
    }

    const barV = show && vSpacing > 0 ? scaleBar(this.zoom / vSpacing) : null;
    ui.vBar.classList.toggle("on", barV !== null);
    if (barV) {
      ui.vSvg.setAttribute("width", String(SCALE_BAR_HEIGHT));
      ui.vSvg.setAttribute("height", String(barV.px + 2));
      ui.vPath.setAttribute("d", scaleBarPathVertical(barV));
      ui.vLabel.textContent = barV.label;
    }
  }

  private setStatus(text: string, isError = false): void {
    this.ui.status.textContent = text;
    this.ui.status.classList.toggle("error", isError);
  }

  private showError(err: unknown): void {
    console.error(err);
    this.setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
  }

  // ---------- Pixel readout ----------

  private valueText(s: SliceData, x: number, y: number): string {
    const i = y * s.cols + x;
    if (s.samples === 3) {
      return `RGB ${s.pixels[i * 3]}, ${s.pixels[i * 3 + 1]}, ${s.pixels[i * 3 + 2]}`;
    }
    const v = (s.pixels[i] as number) * s.slope + s.intercept;
    return this.meta?.modality === "CT" ? `${Math.round(v)} HU` : num(v, 1);
  }

  private updateReadout(e: MouseEvent): void {
    const el = this.ui.readout;
    const s = this.current;
    if (!s || this.drag || this.host.overlay().mode === "off") {
      el.textContent = "";
      return;
    }
    const r = this.el.getBoundingClientRect();
    const p = this.toImage(e.clientX - r.left, e.clientY - r.top);
    const x = Math.floor(p.x);
    const y = Math.floor(p.y);
    if (x < 0 || y < 0 || x >= s.cols || y >= s.rows) {
      el.textContent = "";
      return;
    }
    el.textContent = `(${x}, ${y})  ${this.valueText(s, x, y)}`;
  }

  // ---------- Measurements ----------

  private spacing(): Spacing | null {
    // A calibration set by the user comes first; it is only possible when the file has no
    // patient-calibrated spacing of its own
    if (this.calibration) {
      const m = this.calibration.mmPerPixel;
      return { row: m, col: m, approx: true };
    }
    const sp = this.meta?.pixel_spacing;
    if (!sp || !(sp[0] > 0) || !(sp[1] > 0)) return null;
    return { row: sp[0], col: sp[1], approx: this.meta?.spacing_is_imager ?? false };
  }

  /** True when the file itself carries a spacing that was calibrated to the patient. */
  hasFileSpacing(): boolean {
    const sp = this.meta?.pixel_spacing;
    return !!sp && sp[0] > 0 && sp[1] > 0 && !this.meta?.spacing_is_imager;
  }

  get calibrated(): boolean {
    return this.calibration !== null;
  }

  /** Sets (or with null removes) the user's calibration for everything shown in this view. */
  setCalibration(mmPerPixel: number | null): void {
    this.calibration =
      mmPerPixel !== null && Number.isFinite(mmPerPixel) && mmPerPixel > 0
        ? { mmPerPixel }
        : null;
    // Measurements keep the text they were created with; they would otherwise mix units
    this.measurements.clear();
    this.refreshOverlay();
    this.host.stateChanged(this);
  }

  private sliceKey(): string {
    // Measurements stay with the image when the mask or the shift changes
    const base =
      this.source?.id ?? `${this.angio?.active ? "angio:" : ""}${this.series?.uid ?? ""}`;
    return `${base}#${this.index}`;
  }

  /** Cancels a measurement in progress. Returns true when there was one. */
  cancelDraft(): boolean {
    const had = this.draft !== null || this.aneurysmPts.length > 0;
    this.draft = null;
    this.aneurysmPts = [];
    this.measuring = false;
    this.calibrating = false;
    if (had) this.updateMeasurements();
    return had;
  }

  undoMeasurement(): void {
    if (this.cancelDraft()) return;
    const list = this.measurements.get(this.sliceKey());
    if (list && list.length > 0) {
      list.pop();
      this.updateMeasurements();
    }
  }

  clearMeasurements(): void {
    this.draft = null;
    this.measuring = false;
    this.measurements.delete(this.sliceKey());
    this.updateMeasurements();
  }

  private startMeasure(kind: MeasureKind | "calibrate", p: Pt): void {
    const d = this.draft;

    if (kind === "aneurysm") {
      // Three clicks give the neck and the dome; a fourth gives the widest part of the dome
      const pts = this.aneurysmPts;
      if (pts.length === 0) {
        this.aneurysmPts = [p, { ...p }];
        this.draft = { kind: "aneurysm", pts: this.aneurysmPts };
      } else if (pts.length === 2) {
        pts[1] = p;
        pts.push({ ...p });
      } else if (pts.length === 3) {
        pts[2] = p;
        pts.push({ ...p });
      } else if (pts.length === 4) {
        pts[3] = p;
        pts.push({ ...p });
      }
      this.updateMeasurements();
      return;
    }

    if (kind === "calibrate") {
      this.draft = { kind: "length", pts: [p, { ...p }] };
      this.measuring = true;
      this.calibrating = true;
      this.updateMeasurements();
      return;
    }

    if (kind === "angle" && d !== null && d.kind === "angle") {
      // Angle: first click, vertex, last click
      const [a, b] = d.pts;
      if (d.pts.length === 2 && a) {
        d.pts = [a, p, { ...p }];
      } else if (d.pts.length >= 3 && a && b) {
        this.draft = null;
        this.commit({ kind: "angle", pts: [a, b, p] });
      }
      this.updateMeasurements();
      return;
    }
    this.draft = { kind, pts: [p, { ...p }] };
    this.measuring = kind !== "angle"; // the others are drawn by dragging
    this.updateMeasurements();
  }

  private commit(d: Draft): void {
    const s = this.current;
    const [p0, p1, p2] = d.pts;
    if (!s || !p0 || !p1) return;
    if (d.kind === "aneurysm") return; // finished by finishAneurysm()
    const sp = this.spacing();

    let lines: string[];
    if (d.kind === "length") {
      lines = [lengthText(p0, p1, sp)];
    } else if (d.kind === "angle") {
      if (!p2) return;
      const t = angleText(p0, p1, p2, sp);
      if (t === null) return;
      lines = [t];
    } else {
      lines = roiLines(d.kind, p0, p1, s, sp, this.meta?.modality ?? "");
    }

    const key = this.sliceKey();
    const list = this.measurements.get(key) ?? [];
    list.push({ kind: d.kind, pts: d.pts.map((p) => ({ ...p })), lines });
    this.measurements.set(key, list);
  }

  private finishDragMeasure(): void {
    const d = this.draft;
    const calibrating = this.calibrating;
    this.calibrating = false;
    this.draft = null;
    const [a, b] = d?.pts ?? [];
    if (d && a && b) {
      const sa = this.toScreen(a);
      const sb = this.toScreen(b);
      if (Math.hypot(sa.x - sb.x, sa.y - sb.y) >= 4) {
        if (calibrating) {
          // The distance in image pixels; the host asks for the real length
          this.host.calibrate(this, Math.hypot(b.x - a.x, b.y - a.y));
        } else {
          this.commit(d); // ignore plain clicks
        }
      }
    }
    this.updateMeasurements();
  }

  /** Finishes the aneurysm template with the points collected so far (at least 3 clicks). */
  finishAneurysm(): void {
    const p = this.aneurysmPts;
    this.aneurysmPts = [];
    this.draft = null;
    const neckA = p[0];
    const neckB = p[1];
    const dome = p[2];
    const wa = p[3];
    const wb = p[4];
    const s = this.current;
    if (s && neckA && neckB && dome) {
      const domeWidth: [Pt, Pt] | undefined = wa && wb ? [wa, wb] : undefined;
      const lines = aneurysmLines(
        domeWidth ? { neckA, neckB, dome, domeWidth } : { neckA, neckB, dome },
        this.spacing(),
      );
      const key = this.sliceKey();
      const list = this.measurements.get(key) ?? [];
      list.push({
        kind: "aneurysm",
        pts: [neckA, neckB, dome, ...(domeWidth ?? [])].map((q) => ({ ...q })),
        lines,
      });
      this.measurements.set(key, list);
    }
    this.updateMeasurements();
  }

  /** Enter finishes an aneurysm measurement that has its three main points. */
  finishAneurysmIfPending(): boolean {
    if (this.aneurysmPts.length < 3) return false;
    this.finishAneurysm();
    return true;
  }

  // Cheap text for a measurement that is still being drawn
  private liveLines(d: Draft): string[] {
    if (d.kind === "aneurysm") {
      const [a, b, c] = d.pts;
      if (!a || !b || !c || d.pts.length < 3) return ["Neck: click two points"];
      return aneurysmLines({ neckA: a, neckB: b, dome: c }, this.spacing());
    }
    const [p0, p1, p2] = d.pts;
    if (!p0 || !p1) return [];
    const sp = this.spacing();
    if (d.kind === "length") return [lengthText(p0, p1, sp)];
    if (d.kind === "angle") {
      const t = p2 ? angleText(p0, p1, p2, sp) : null;
      return t ? [t] : [];
    }
    return [`Area ${areaText(shapeAreaPx(d.kind, p0, p1), sp)}`];
  }

  private textNode(at: Pt, lines: string[]): SVGTextElement {
    const w = this.el.clientWidth;
    const h = this.el.clientHeight;
    const x = clamp(at.x, 4, Math.max(4, w - 150));
    const y = clamp(at.y, 14, Math.max(14, h - 14 * lines.length));
    const t = svgEl("text", { x, y, class: "m-text" });
    lines.forEach((line, i) => {
      const span = svgEl("tspan", { x, dy: i === 0 ? 0 : 14 });
      span.textContent = line;
      t.append(span);
    });
    return t;
  }

  private shapeNodes(kind: MeasureKind, pts: Pt[], lines: string[]): SVGElement[] {
    const s = pts.map((p) => this.toScreen(p));
    const first = s[0];
    const second = s[1];
    if (!first || !second) return [];

    const stroke = { stroke: MEASURE_COLOR, "stroke-width": 1.5, fill: "none" };
    const dot = (p: Pt) => svgEl("circle", { cx: p.x, cy: p.y, r: 3, fill: MEASURE_COLOR });
    const out: SVGElement[] = [];
    let labelAt: Pt;

    if (kind === "length") {
      out.push(svgEl("line", { x1: first.x, y1: first.y, x2: second.x, y2: second.y, ...stroke }));
      out.push(dot(first), dot(second));
      labelAt = { x: (first.x + second.x) / 2 + 8, y: (first.y + second.y) / 2 - 8 };
    } 
    if (kind === "aneurysm") {
      const [a, b, c, wa, wb] = s;
      if (a && b) {
        out.push(svgEl("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ...stroke }), dot(a), dot(b));
      }
      if (a && b && c) {
        // A line from the middle of the neck to the dome point shows the height
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        out.push(
          svgEl("line", {
            x1: mid.x, y1: mid.y, x2: c.x, y2: c.y, ...stroke, "stroke-dasharray": "4 3",
          }),
          dot(c),
        );
      }
      if (wa && wb) {
        out.push(svgEl("line", { x1: wa.x, y1: wa.y, x2: wb.x, y2: wb.y, ...stroke }), dot(wa), dot(wb));
      }
      const label = a && b ? { x: Math.max(a.x, b.x) + 10, y: Math.min(a.y, b.y) } : first;
      if (lines.length > 0) out.push(this.textNode(label, lines));
      return out;
    } else if (kind === "angle") {
      const third = s[2];
      const d = [`M${first.x} ${first.y}`, `L${second.x} ${second.y}`];
      if (third) d.push(`L${third.x} ${third.y}`);
      out.push(svgEl("path", { d: d.join(" "), ...stroke }), dot(second));
      labelAt = { x: second.x + 10, y: second.y - 10 };
    } else {
      // A quarter turn keeps boxes axis-aligned, so the screen bounding box is exact
      const x = Math.min(first.x, second.x);
      const y = Math.min(first.y, second.y);
      const w = Math.abs(second.x - first.x);
      const h = Math.abs(second.y - first.y);
      out.push(
        kind === "rect"
          ? svgEl("rect", { x, y, width: w, height: h, ...stroke })
          : svgEl("ellipse", { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, ...stroke }),
      );
      labelAt = { x, y: y + h + 14 };
    }

    if (lines.length > 0) out.push(this.textNode(labelAt, lines));
    return out;
  }

  // Lines that mark where other planes cut this view, across the whole image
  private refNodes(): SVGElement[] {
    const s = this.current;
    if (!s) return [];
    return this.refLines.map((l) => {
      const a: Pt = l.axis === "x" ? { x: l.pos, y: 0 } : { x: 0, y: l.pos };
      const b: Pt = l.axis === "x" ? { x: l.pos, y: s.rows } : { x: s.cols, y: l.pos };
      const p = this.toScreen(a);
      const q = this.toScreen(b);
      return svgEl("line", {
        x1: p.x, y1: p.y, x2: q.x, y2: q.y,
        stroke: l.color, "stroke-width": 1, "stroke-opacity": 0.85,
      });
    });
  }

  private updateMeasurements(): void {
    const svg = this.ui.measure;
    if (!this.current || this.el.hidden) {
      svg.replaceChildren();
      return;
    }
    const nodes: SVGElement[] = [...this.refNodes()];
    for (const m of this.measurements.get(this.sliceKey()) ?? []) {
      nodes.push(...this.shapeNodes(m.kind, m.pts, m.lines));
    }
    if (this.draft) nodes.push(...this.shapeNodes(this.draft.kind, this.draft.pts, this.liveLines(this.draft)));
    svg.replaceChildren(...nodes);
  }

  // ---------- Crosshair ----------

  // At most one pick per frame: moving the crosshair makes other views load new images
  private pickAt(clientX: number, clientY: number): void {
    this.crossPt = { x: clientX, y: clientY };
    if (this.crossRaf) return;
    this.crossRaf = requestAnimationFrame(() => {
      this.crossRaf = 0;
      const p = this.crossPt;
      this.crossPt = null;
      if (!p) return;
      const r = this.el.getBoundingClientRect();
      this.host.pick(this, this.toImage(p.x - r.left, p.y - r.top));
    });
  }

  // ---------- Mouse ----------
  // Wheel: scroll images. Pinch (ctrl+wheel): zoom at the cursor.
  // Left drag: active tool. Right / middle / Shift+left drag: pan.
  // Touching a viewport makes it the active one.

  private bindMouse(): void {
    const el = this.el;

    el.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        this.host.activate(this);
        if (!this.current) return;
        if (e.ctrlKey) {
          const r = el.getBoundingClientRect();
          this.zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
          return;
        }
        this.wheelAcc += e.deltaY;
        const steps = Math.trunc(this.wheelAcc / 40);
        if (steps !== 0) {
          this.wheelAcc -= steps * 40;
          this.goto(this.index + steps);
        }
      },
      { passive: false },
    );

    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("mousemove", (e: MouseEvent) => this.updateReadout(e));
    el.addEventListener("mouseleave", () => {
      this.ui.readout.textContent = "";
    });

    el.addEventListener("mousedown", (e: MouseEvent) => {
      this.host.activate(this);
      if (!this.current) return;
      const panOverride = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
      const r = el.getBoundingClientRect();
      const tool = this.host.tool();

      if (tool === "calibrate" && e.button === 0 && !panOverride) {
        this.startMeasure("calibrate", this.toImage(e.clientX - r.left, e.clientY - r.top));
        e.preventDefault();
        return;
      }

      if (isMeasureTool(tool) && e.button === 0 && !panOverride) {
        this.startMeasure(tool, this.toImage(e.clientX - r.left, e.clientY - r.top));
        e.preventDefault();
        return;
      }
      if (tool === "cross" && e.button === 0 && !panOverride) {
        this.crossing = true;
        this.pickAt(e.clientX, e.clientY);
        e.preventDefault();
        return;
      }

      if (tool === "rotate" && e.button === 0 && !panOverride) {
        this.rotating = true;
        this.host.rotate(this, "down", e.clientX - r.left, e.clientY - r.top);
        e.preventDefault();
        return;
      }

      if (tool === "maskshift" && e.button === 0 && !panOverride) {
        const a = this.angio;
        if (a?.dsa) {
          const p = this.toImage(e.clientX - r.left, e.clientY - r.top);
          this.shifting = { p0: p, dx0: a.dx, dy0: a.dy };
        }
        e.preventDefault();
        return;
      }

      const mode: DragMode =
        panOverride ||
        isMeasureTool(tool) ||
        tool === "cross" ||
        tool === "calibrate" ||
        tool === "rotate" ||
        tool === "maskshift"
          ? "pan"
          : tool;
      this.drag = {
        mode,
        x: e.clientX, y: e.clientY,
        ax: e.clientX - r.left, ay: e.clientY - r.top,
        wl: this.wl, ww: this.ww,
        panX: this.panX, panY: this.panY, zoom: this.zoom,
        index: this.index,
      };
      e.preventDefault();
    });

    window.addEventListener("mouseup", () => {
      this.drag = null;
      this.crossing = false;
      if (this.rotating) {
        this.rotating = false;
        this.shifting = null;
        this.host.rotate(this, "up", 0, 0);
      }
      if (this.measuring) {
        this.measuring = false;
        this.finishDragMeasure();
      }
    });

    window.addEventListener("mousemove", (e: MouseEvent) => {
      if (this.crossing) this.pickAt(e.clientX, e.clientY);

      if (this.rotating) {
        const r = el.getBoundingClientRect();
        this.host.rotate(this, "move", e.clientX - r.left, e.clientY - r.top);
      }

      const sh = this.shifting;
      if (sh) {
        const r = el.getBoundingClientRect();
        const p = this.toImage(e.clientX - r.left, e.clientY - r.top);
        this.setShift(sh.dx0 + Math.round(p.x - sh.p0.x), sh.dy0 + Math.round(p.y - sh.p0.y));
      }

      // The last point of a measurement in progress follows the cursor
      const dr = this.draft;
      if (dr && (dr.kind === "angle" || dr.kind === "aneurysm" || this.measuring)) {
        const r = el.getBoundingClientRect();
        dr.pts[dr.pts.length - 1] = this.toImage(e.clientX - r.left, e.clientY - r.top);
        this.updateMeasurements();
      }

      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;

      switch (d.mode) {
        case "window":
          this.setWindow(d.wl + dy * 2, d.ww + dx * 2, true);
          break;
        case "pan":
          this.panX = d.panX + dx;
          this.panY = d.panY + dy;
          this.autoFit = false;
          this.applyTransform();
          this.updateMeasurements();
          break;
        case "zoom": {
          // Drag up to zoom in, anchored at the point where the drag started
          const z2 = clamp(d.zoom * Math.exp(-dy * 0.01), 0.05, 50);
          const k = z2 / d.zoom;
          this.panX = d.ax - (d.ax - d.panX) * k;
          this.panY = d.ay - (d.ay - d.panY) * k;
          this.zoom = z2;
          this.autoFit = false;
          this.applyTransform();
          this.refreshOverlay();
          break;
        }
        case "scroll":
          this.goto(d.index + Math.trunc(dy / 8)); // 8 px per image
          break;
      }
    });

    el.addEventListener("dblclick", () => {
      // A double click finishes an aneurysm measurement; otherwise it fits the image
      if (this.aneurysmPts.length >= 3) {
        this.finishAneurysm();
        return;
      }
      const tool = this.host.tool();
      if (
        !isMeasureTool(tool) &&
        tool !== "cross" &&
        tool !== "calibrate" &&
        tool !== "rotate" &&
        tool !== "maskshift"
      ) {
        // With several views a double click enlarges this one (and restores the layout);
        // with a single view it fits the image
        if (this.host.canMaximize()) this.host.toggleMaximize(this);
        else this.fit();
      }
    });
  }
}