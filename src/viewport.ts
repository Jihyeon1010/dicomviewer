import { getSeriesGeometry, getSlice, getSliceMeta } from "./api";
import { cleanName, compact, fmtAge, fmtDate, fmtTime, num } from "./format";
import {
  edgeLabels,
  SCALE_BAR_HEIGHT,
  scaleBar,
  scaleBarPath,
  scaleBarPathVertical,
} from "./guides";
import { GLRenderer } from "./renderer";
import type { OverlayMode } from "./settings";
import type { SeriesGeometry, SeriesInfo, SliceData, SliceMeta } from "./types";

export type ToolId = "window" | "pan" | "zoom" | "scroll";

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
}

interface Drag {
  mode: ToolId;
  x: number; y: number;   // pointer start (client coordinates)
  ax: number; ay: number; // anchor point in viewport coordinates
  wl: number; ww: number;
  panX: number; panY: number; zoom: number;
  index: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function div(className: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = className;
  return d;
}

// Views smaller than this cannot hold the full overlay
const SMALL_W = 360;
const SMALL_H = 260;

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

  const status = div("vp-status");
  const emptyTitle = div("vp-empty-title");
  const emptySub = div("vp-empty-sub");
  const empty = div("vp-empty");
  empty.append(emptyTitle, emptySub);

  root.append(canvas, tl, tr, bl, br, markerT, markerB, markerL, markerR, hBar, vBar, status, empty);
  return {
    canvas, tl, tr, bl, br,
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
    ? `Px ${num(m.pixel_spacing[1], 3)} × ${num(m.pixel_spacing[0], 3)} mm`
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
  geometry: SeriesGeometry | null = null;
  extraLines: string[] = []; // appended to the bottom-left overlay (volume info)

  private readonly host: ViewportHost;
  private readonly ui: Ui;
  private renderer: GLRenderer | null = null;
  private current: SliceData | null = null;
  private meta: SliceMeta | null = null;
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private autoFit = true; // keep the image fitted until the user zooms or pans
  private firstLoad = true; // apply the file's default WL/WW only once per series
  private fetchToken = 0;
  private drawQueued = false;
  private drag: Drag | null = null;
  private wheelAcc = 0;

  /** True when the shown image is in colour; windowing does not apply to those. */
  get color(): boolean {
    return this.current?.samples === 3;
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

  /** Shows a series (or clears the viewport). Resolves once the first image is loaded. */
  setSeries(series: SeriesInfo | null): Promise<void> {
    this.fetchToken++; // drops responses that are still in flight for the old series
    this.series = series;
    this.count = series?.slice_count ?? 0;
    this.index = 0;
    this.firstLoad = true;
    this.autoFit = true;
    this.current = null;
    this.meta = null;
    this.geometry = null;
    this.extraLines = [];
    this.setStatus("");
    this.el.classList.toggle("empty", series === null);
    this.refreshOverlay();
    this.host.stateChanged(this);

    if (!series) return Promise.resolve();
    void this.loadGeometry(series.uid);
    return this.loadSlice();
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
    if (on) this.requestDraw();
  }

  private async loadGeometry(uid: string): Promise<void> {
    try {
      const g = await getSeriesGeometry(uid);
      if (this.series?.uid === uid) this.geometry = g;
    } catch (err) {
      // Linking with other viewports is simply unavailable without geometry
      console.warn(`Geometry unavailable for series ${uid}`, err);
    }
  }

  private async loadSlice(): Promise<void> {
    const series = this.series;
    if (!series || this.count === 0) return;
    const token = ++this.fetchToken;
    try {
      // Metadata is optional: a failure there must not block the image
      const [slice, m] = await Promise.all([
        getSlice(series.uid, this.index),
        getSliceMeta(series.uid, this.index).catch(() => null),
      ]);
      if (token !== this.fetchToken) return; // a newer request superseded this one

      const dimsChanged =
        !this.current || this.current.rows !== slice.rows || this.current.cols !== slice.cols;
      this.current = slice;
      this.meta = m;
      this.renderer?.upload(slice);

      if (this.firstLoad) {
        if (slice.defaultWl !== null && slice.defaultWw !== null) {
          this.wl = slice.defaultWl;
          this.ww = slice.defaultWw;
        }
        this.firstLoad = false;
      }
      if (dimsChanged) {
        // Resizing clears the drawing buffer, so draw right after
        this.ui.canvas.width = slice.cols;
        this.ui.canvas.height = slice.rows;
        if (this.autoFit) this.fitView();
      }
      this.setStatus("");
      this.draw();
      this.host.stateChanged(this); // grayscale or colour decides which controls apply
    } catch (err) {
      if (token === this.fetchToken) this.showError(err);
    }
  }

  // ---------- Navigation and window ----------

  goto(next: number, notify = true): void {
    if (this.count === 0) return;
    const clamped = Math.max(0, Math.min(this.count - 1, next));
    if (clamped === this.index) return;
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

  // ---------- View transform ----------

  private applyTransform(): void {
    this.ui.canvas.style.transform =
      `translate(${this.panX}px, ${this.panY}px) scale(${this.zoom})`;
  }

  private fitView(): void {
    const s = this.current;
    if (!s) return;
    const r = this.el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.zoom = Math.min(r.width / s.cols, r.height / s.rows);
    this.panX = (r.width - s.cols * this.zoom) / 2;
    this.panY = (r.height - s.rows * this.zoom) / 2;
    this.autoFit = true;
    this.applyTransform();
  }

  fit(): void {
    this.fitView();
    this.refreshOverlay();
  }

  private zoomAt(factor: number, cx: number, cy: number): void {
    const z2 = Math.min(50, Math.max(0.05, this.zoom * factor));
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

  // ---------- Overlay ----------

  refreshOverlay(): void {
    this.el.classList.toggle("small", this.isSmall());
    this.updateText();
    this.updateGuides();
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
    bl.textContent = full
      ? [...imageLines(this.index, this.count, s, m), ...this.extraLines].join("\n")
      : this.count
        ? `Im ${this.index + 1} / ${this.count}`
        : "";

    const zoomText = `Zoom ${Math.round(this.zoom * 100)}%`;
    if (!s) {
      br.textContent = "";
    } else if (s.samples === 3) {
      br.textContent = `${this.invert ? "(inverted)\n" : ""}${zoomText}`;
    } else {
      br.textContent =
        `WL ${Math.round(this.wl)}  WW ${Math.round(this.ww)}${this.invert ? "  (inverted)" : ""}\n` +
        zoomText;
    }
  }

  // Orientation markers and scale bars. Independent of the text overlay mode.
  private updateGuides(): void {
    const ui = this.ui;
    const show = this.host.overlay().markers && this.current !== null;

    const labels = show ? edgeLabels(this.meta) : null;
    ui.markerT.textContent = labels?.top ?? "";
    ui.markerB.textContent = labels?.bottom ?? "";
    ui.markerL.textContent = labels?.left ?? "";
    ui.markerR.textContent = labels?.right ?? "";

    // Horizontal ruler: the column spacing is the horizontal step in millimetres
    const colSpacing = this.meta?.pixel_spacing?.[1] ?? 0;
    const bar = show && colSpacing > 0 ? scaleBar(this.zoom / colSpacing) : null;
    ui.hBar.classList.toggle("on", bar !== null);
    if (bar) {
      ui.hSvg.setAttribute("width", String(bar.px + 2));
      ui.hSvg.setAttribute("height", String(SCALE_BAR_HEIGHT));
      ui.hPath.setAttribute("d", scaleBarPath(bar));
      ui.hLabel.textContent = bar.label;
    }

    // Vertical ruler: the row spacing is the vertical step in millimetres
    const rowSpacing = this.meta?.pixel_spacing?.[0] ?? 0;
    const barV = show && rowSpacing > 0 ? scaleBar(this.zoom / rowSpacing) : null;
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

    el.addEventListener("mousedown", (e: MouseEvent) => {
      this.host.activate(this);
      if (!this.current) return;
      const panOverride = e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey);
      const r = el.getBoundingClientRect();
      this.drag = {
        mode: panOverride ? "pan" : this.host.tool(),
        x: e.clientX, y: e.clientY,
        ax: e.clientX - r.left, ay: e.clientY - r.top,
        wl: this.wl, ww: this.ww,
        panX: this.panX, panY: this.panY, zoom: this.zoom,
        index: this.index,
      };
      e.preventDefault();
    });

    window.addEventListener("mouseup", () => { this.drag = null; });

    window.addEventListener("mousemove", (e: MouseEvent) => {
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
          break;
        case "zoom": {
          // Drag up to zoom in, anchored at the point where the drag started
          const z2 = Math.min(50, Math.max(0.05, d.zoom * Math.exp(-dy * 0.01)));
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

    el.addEventListener("dblclick", () => this.fit());
  }
}