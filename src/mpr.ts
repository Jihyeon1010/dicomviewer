import { getMprSlice, getObliqueSlice } from "./api";
import type { CachedSlice, SliceSource } from "./slice-cache";
import { matrix, type Pt } from "./transform2d";
import type { Plane, SeriesInfo, SlabMode, SliceMeta, VolumeInfo } from "./types";
import { add, cross, dot, rotateAbout, scale, sub, unit, type V3 } from "./vec3";
import type { RefLine, Viewport } from "./viewport";

export const PLANES: Plane[] = ["axial", "coronal", "sagittal"];

export interface Slab {
  mode: SlabMode;
  mm: number; // thickness; ignored when mode is "none"
}

/** Thickness that reaches through the whole volume */
export const FULL_MM = 1e6;

// Directions of the rotation controls. If a drag turns the image the wrong way, flip a sign.
const TWIST_SIGN = 1;
const BALL_X = -1;
const BALL_Y = 1;
const BALL_RAD_PER_PX = 0.007;

const MAX_SIDE = 1024; // longest side of an oblique image
const MIP_FINAL = 2; // output scale of the 3D MIP view at rest and while dragging
const MIP_PREVIEW = 4;

// Colour of the reference line that marks where each plane cuts the other views
const COLOR: Record<Plane, string> = {
  axial: "#ff7a7a",
  coronal: "#62d98a",
  sagittal: "#62aaff",
};

const EMPTY_META: SliceMeta = {
  patient_name: "",
  patient_id: "",
  patient_sex: "",
  patient_age: "",
  patient_birth_date: "",
  institution: "",
  study_description: "",
  study_date: "",
  study_time: "",
  series_description: "",
  series_number: "",
  modality: "",
  manufacturer_model: "",
  slice_location: null,
  slice_thickness: null,
  kvp: null,
  tube_current: null,
  pixel_spacing: null,
  spacing_is_imager: false,
  cine_fps: null,
  image_orientation: null,
  patient_orientation: "",
  frame: 0,
  frame_count: 1,
};

// ---------- Volume geometry ----------
// Local coordinates in millimetres: x = column * sx, y = row * sy, z = image position.
// The rules for sizes and spacing must match src-tauri/src/mpr.rs.

interface Geo {
  cols: number;
  rows: number;
  depth: number;
  sx: number;
  sy: number;
  z: number[]; // image positions in mm, ascending
}

function geoOf(v: VolumeInfo): Geo {
  const ps = v.pixel_spacing;
  const z =
    v.z_positions.length === v.depth
      ? v.z_positions
      : Array.from({ length: v.depth }, (_, k) => k);
  return {
    cols: v.cols,
    rows: v.rows,
    depth: v.depth,
    sx: ps && ps[1] > 0 ? ps[1] : 1,
    sy: ps && ps[0] > 0 ? ps[0] : 1,
    z,
  };
}

function countOf(plane: Plane, g: Geo): number {
  return plane === "axial" ? g.depth : plane === "coronal" ? g.rows : g.cols;
}

// Millimetres per pixel of the resampled vertical axis of the coronal and sagittal views
function zStep(plane: Plane, g: Geo): number {
  return plane === "coronal" ? g.sx : g.sy;
}

// True when a slab reaches every image whatever the position, so all positions look alike
function covers(plane: Plane, g: Geo, s: Slab): boolean {
  if (s.mode === "none") return false;
  const half = s.mm / 2;
  if (plane === "axial") {
    const last = g.z[g.depth - 1] ?? 0;
    return half + 1e-6 >= last - (g.z[0] ?? 0);
  }
  const voxels = Math.floor(half / (plane === "coronal" ? g.sy : g.sx) + 1e-9);
  return voxels >= countOf(plane, g) - 1;
}

function nearestZ(z: number[], mm: number): number {
  let lo = 0;
  let hi = z.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((z[mid] as number) <= mm) lo = mid;
    else hi = mid;
  }
  const a = Math.abs((z[lo] as number) - mm);
  const b = Math.abs((z[hi] as number) - mm);
  return a <= b ? lo : hi;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ---------- Frames ----------
// The three planes are the coordinate planes of an orthonormal frame, which starts out
// aligned with the volume and can be rotated.

interface Frame {
  x: V3;
  y: V3;
  z: V3;
}

interface Axes {
  u: V3; // direction of the image's x axis
  v: V3; // direction of the image's y axis
  n: V3; // direction in which the image index grows
}

type AxisName = "x" | "y" | "z";

const identityFrame = (): Frame => ({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] });

function nearIdentity(f: Frame): boolean {
  const d = [f.x[0] - 1, f.y[1] - 1, f.z[2] - 1, f.x[1], f.x[2], f.y[0], f.y[2], f.z[0], f.z[1]];
  return d.every((v) => Math.abs(v) < 1e-9);
}

function axesOf(f: Frame, plane: Plane): Axes {
  if (plane === "axial") return { u: f.x, v: f.y, n: f.z };
  if (plane === "coronal") return { u: f.x, v: f.z, n: f.y };
  return { u: f.y, v: f.z, n: f.x };
}

// Sign of (u x v) . n for each view
const HAND: Record<Plane, number> = { axial: 1, coronal: -1, sagittal: 1 };
const AXIS_NAMES: Record<Plane, [AxisName, AxisName]> = {
  axial: ["x", "y"],
  coronal: ["x", "z"],
  sagittal: ["y", "z"],
};
const PLANE_OF_NORMAL: Record<AxisName, Plane> = { x: "sagittal", y: "coronal", z: "axial" };

function fixFrame(f: Frame): Frame {
  const x = unit(f.x);
  const y = unit(sub(f.y, scale(x, dot(x, f.y))));
  return { x, y, z: cross(x, y) };
}

// Rotates the two axes other than the normal of `plane` about that normal
function twisted(f: Frame, plane: Plane, beta: number): Frame {
  const r = (a: V3, k: V3): V3 => rotateAbout(a, k, beta);
  if (plane === "axial") return fixFrame({ x: r(f.x, f.z), y: r(f.y, f.z), z: f.z });
  if (plane === "coronal") return fixFrame({ x: r(f.x, f.y), y: f.y, z: r(f.z, f.y) });
  return fixFrame({ x: f.x, y: r(f.y, f.x), z: r(f.z, f.x) });
}

// The 3D MIP view looks along y, like a coronal projection; (u, v, n) is left-handed
const baseMipAxes = (): Axes => ({ u: [1, 0, 0], v: [0, 0, 1], n: [0, 1, 0] });

function fixAxes(a: Axes): Axes {
  const u = unit(a.u);
  const v = unit(sub(a.v, scale(u, dot(u, a.v))));
  return { u, v, n: scale(cross(u, v), -1) };
}

// phi turns about v, psi about u; positive phi turns the view to the left
function trackball(base: Axes, phi: number, psi: number): Axes {
  const r1 = (a: V3): V3 => rotateAbout(a, base.v, phi);
  const u1 = r1(base.u);
  const n1 = r1(base.n);
  const r2 = (a: V3): V3 => rotateAbout(a, u1, psi);
  return fixAxes({ u: u1, v: r2(base.v), n: r2(n1) });
}

// ---------- Names ----------

// Anatomical name of the plane spanned by two direction vectors (patient LPS axes)
function planeName(a: V3, b: V3): string {
  const n = cross(a, b);
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-6) return "Oblique";
  const ax =
    Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2])
      ? 0
      : Math.abs(n[1]) >= Math.abs(n[2])
        ? 1
        : 2;
  if (Math.abs(n[ax] as number) / len < 0.9) return "Oblique";
  return ["Sagittal", "Coronal", "Axial"][ax] ?? "Oblique";
}

function slabText(s: Slab): string {
  if (s.mode === "none") return "";
  const name = s.mode === "max" ? "MIP" : s.mode === "min" ? "MinIP" : "Average";
  return ` ${name} ${s.mm >= FULL_MM / 10 ? "(all)" : `${s.mm} mm`}`;
}

const keyOf = (a: Axes): string => [...a.u, ...a.v].map((x) => x.toFixed(5)).join(",");

// ---------- Controller ----------

export interface MprOptions {
  panes: [Viewport, Viewport, Viewport]; // axial, coronal and sagittal view
  extra: Viewport; // the fourth view; can show a rotating 3D MIP
  series: SeriesInfo;
  volume: VolumeInfo;
  baseMeta: SliceMeta | null; // patient and study fields come from here
}

/**
 * Three linked views of one volume. The crosshair is a point in the volume; each view shows
 * the plane through it. The frame can be rotated, which tilts the planes.
 */
export class Mpr {
  readonly series: SeriesInfo;
  readonly panes: Viewport[];

  private readonly extra: Viewport;
  private readonly volume: VolumeInfo;
  private readonly base: SliceMeta | null;
  private readonly g: Geo;
  private readonly v0: V3; // middle of the volume
  private readonly z0: number;
  private readonly zl: number;
  private readonly diag: number;
  private readonly p0: number; // finest pixel size of oblique images
  private slab: Slab;
  private c: V3;
  private frame: Frame = identityFrame();
  private scaleNow = 1; // output scale of the oblique views currently shown
  private mip = false;
  private mipAxes: Axes = baseMipAxes();
  private mipScaleNow = MIP_FINAL;
  private twistState: {
    plane: Plane;
    vp: Viewport;
    start: Frame;
    a0: number;
    cx: number;
    cy: number;
  } | null = null;
  private ball: { base: Axes; x: number; y: number } | null = null;
  private dirty = false;
  private raf = 0;

  constructor(opts: MprOptions, slab: Slab) {
    this.series = opts.series;
    this.panes = [...opts.panes];
    this.extra = opts.extra;
    this.volume = opts.volume;
    this.base = opts.baseMeta;
    this.slab = slab;

    const g = geoOf(opts.volume);
    this.g = g;
    this.z0 = g.z[0] ?? 0;
    this.zl = g.z[g.z.length - 1] ?? 0;
    const hx = ((g.cols - 1) * g.sx) / 2;
    const hy = ((g.rows - 1) * g.sy) / 2;
    this.v0 = [hx, hy, (this.z0 + this.zl) / 2];
    this.diag = Math.max(1, Math.hypot(2 * hx, 2 * hy, this.zl - this.z0));
    let p0 = Math.min(g.sx, g.sy);
    if (Math.ceil(this.diag / p0) + 2 > MAX_SIDE) p0 = this.diag / (MAX_SIDE - 2);
    this.p0 = p0;
    this.c = [...this.v0];
  }

  get mipOn(): boolean {
    return this.mip;
  }

  get rotated(): boolean {
    return !nearIdentity(this.frame);
  }

  /** The crosshair position as voxel indices: column, row and image. */
  get pos(): { i: number; r: number; k: number } {
    const g = this.g;
    return {
      i: clamp(Math.round(this.c[0] / g.sx), 0, g.cols - 1),
      r: clamp(Math.round(this.c[1] / g.sy), 0, g.rows - 1),
      k: nearestZ(g.z, this.c[2]),
    };
  }

  owns(vp: Viewport): boolean {
    return this.panes.includes(vp);
  }

  planeOf(vp: Viewport): Plane | null {
    const n = this.panes.indexOf(vp);
    return n < 0 ? null : (PLANES[n] ?? null);
  }

  /** Shows the three views with the crosshair in the middle of the volume. */
  async start(): Promise<void> {
    this.c = [...this.v0];
    this.frame = identityFrame();
    this.scaleNow = 1;
    const loads = PLANES.map((plane, n) => {
      const vp = this.panes[n];
      if (!vp) return Promise.resolve();
      return vp.setReformat(
        this.series,
        this.sourceFor(plane),
        this.paneCount(plane),
        this.paneIndex(plane),
        plane,
      );
    });
    this.updateRefLines();
    await Promise.all(loads);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.twistState = null;
    this.ball = null;
    for (const vp of this.panes) vp.setRefLines([]);
  }

  /** Changes the projection of all three views and keeps their positions and zoom. */
  setSlab(slab: Slab): void {
    this.slab = slab;
    this.scaleNow = this.rotated ? this.finalScale() : 1;
    this.refreshPanes();
  }

  resetRotation(): void {
    this.frame = identityFrame();
    this.scaleNow = 1;
    this.refreshPanes();
    if (this.mip) {
      this.mipAxes = baseMipAxes();
      this.mipScaleNow = MIP_FINAL;
      this.refreshMip();
    }
  }

  /** Turns the fourth view into a rotating 3D MIP, or back into the plain series. */
  setMipView(on: boolean): void {
    if (on === this.mip) return;
    this.mip = on;
    if (on) {
      this.mipAxes = baseMipAxes();
      this.mipScaleNow = MIP_FINAL;
      void this.extra.setReformat(this.series, this.mipSource(), 1, 0, "coronal");
    } else {
      void this.extra.setSeries(this.series);
    }
  }

  // ---------- Crosshair ----------

  /** A view was scrolled: the crosshair follows along the normal of that view. */
  scrolled(vp: Viewport): void {
    const plane = this.planeOf(vp);
    if (!plane) return;
    const g = this.g;
    if (this.rotated) {
      const n = axesOf(this.frame, plane).n;
      const t = this.tOf(n, vp.index);
      this.c = add(this.c, scale(n, t - dot(sub(this.c, this.v0), n)));
    } else if (plane === "axial") {
      this.c = [this.c[0], this.c[1], g.z[vp.index] ?? this.c[2]];
    } else if (plane === "coronal") {
      this.c = [this.c[0], vp.index * g.sy, this.c[2]];
    } else {
      this.c = [vp.index * g.sx, this.c[1], this.c[2]];
    }
    this.updateRefLines();
  }

  /** The crosshair tool was used at `p` (image coordinates) of a view. */
  pick(vp: Viewport, p: Pt): void {
    const plane = this.planeOf(vp);
    if (!plane) return;
    const g = this.g;

    if (this.rotated) {
      const ax = axesOf(this.frame, plane);
      const cp = this.crossPos(plane);
      const px = this.sizeAt(this.scaleNow).p;
      this.c = add(
        this.c,
        add(scale(ax.u, (p.x - cp.x) * px), scale(ax.v, (p.y - cp.y) * px)),
      );
    } else {
      const col = (x: number): number => clamp(Math.floor(x), 0, g.cols - 1);
      const row = (y: number): number => clamp(Math.floor(y), 0, g.rows - 1);
      // Row j of a resampled view sits at z[0] + j * step, and pixel centres are at j + 0.5
      const image = (y: number): number =>
        nearestZ(g.z, this.z0 + (y - 0.5) * zStep(plane, g));
      const c = this.c;
      if (plane === "axial") this.c = [col(p.x) * g.sx, row(p.y) * g.sy, c[2]];
      else if (plane === "coronal") this.c = [col(p.x) * g.sx, c[1], g.z[image(p.y)] ?? c[2]];
      else this.c = [c[0], row(p.x) * g.sy, g.z[image(p.y)] ?? c[2]];
    }

    this.c = [
      clamp(this.c[0], 0, (g.cols - 1) * g.sx),
      clamp(this.c[1], 0, (g.rows - 1) * g.sy),
      clamp(this.c[2], this.z0, this.zl),
    ];
    PLANES.forEach((other, n) => {
      if (other !== plane) this.panes[n]?.goto(this.paneIndex(other), false, true);
    });
    this.updateRefLines();
  }

  // ---------- Rotation ----------

  /** The rotate tool went down at (x, y) in the coordinates of the view `vp`. */
  rotateDown(vp: Viewport, x: number, y: number): void {
    if (this.mip && vp === this.extra) {
      this.ball = { base: this.mipAxes, x, y };
      return;
    }
    const plane = this.planeOf(vp);
    const ctr = vp.imageCenterOnScreen();
    if (!plane || !ctr) return;
    this.twistState = {
      plane,
      vp,
      start: this.frame,
      a0: Math.atan2(y - ctr.y, x - ctr.x),
      cx: ctr.x,
      cy: ctr.y,
    };
  }

  rotateMove(vp: Viewport, x: number, y: number): void {
    if (this.ball && vp === this.extra) {
      // The drag in screen pixels, expressed along the axes of the image
      const m = matrix(vp.orientation);
      const dx = x - this.ball.x;
      const dy = y - this.ball.y;
      const di = m.a * dx + m.c * dy;
      const dj = m.b * dx + m.d * dy;
      this.mipAxes = trackball(
        this.ball.base,
        BALL_X * di * BALL_RAD_PER_PX,
        BALL_Y * dj * BALL_RAD_PER_PX,
      );
      this.mipScaleNow = MIP_PREVIEW;
      this.dirty = true;
      this.schedule();
      return;
    }

    const t = this.twistState;
    if (!t || t.vp !== vp) return;
    let d = Math.atan2(y - t.cy, x - t.cx) - t.a0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    // A mirrored view turns the opposite way on screen
    const o = vp.orientation;
    const mirror = o.flipH !== o.flipV ? -1 : 1;
    this.frame = twisted(t.start, t.plane, TWIST_SIGN * -HAND[t.plane] * mirror * d);
    this.scaleNow = this.previewScale();
    this.dirty = true;
    this.schedule();
  }

  rotateUp(): void {
    if (this.ball) {
      this.ball = null;
      this.dirty = false;
      this.mipScaleNow = MIP_FINAL;
      this.refreshMip();
    } else if (this.twistState) {
      this.twistState = null;
      this.dirty = false;
      this.scaleNow = this.finalScale();
      this.refreshPanes();
    }
  }

  // Redraws at most once per frame, and only when the previous images have arrived
  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!this.dirty) return;
      if (this.panes.some((p) => p.busy) || (this.mip && this.extra.busy)) {
        this.schedule();
        return;
      }
      this.dirty = false;
      if (this.twistState) this.refreshPanes();
      if (this.ball) this.refreshMip();
    });
  }

  private previewScale(): number {
    return this.slab.mode === "none" ? 2 : 4;
  }

  private finalScale(): number {
    return this.slab.mode === "none" ? 1 : 2;
  }

  // ---------- Positions of the planes ----------

  private ext(n: V3): number {
    const g = this.g;
    return (
      (Math.abs(n[0]) * (g.cols - 1) * g.sx +
        Math.abs(n[1]) * (g.rows - 1) * g.sy +
        Math.abs(n[2]) * (this.zl - this.z0)) /
      2
    );
  }

  private get stepMm(): number {
    return Math.min(this.g.sx, this.g.sy);
  }

  private obCount(n: V3): number {
    return Math.floor((2 * this.ext(n)) / this.stepMm + 1e-9) + 1;
  }

  private tOf(n: V3, index: number): number {
    return -this.ext(n) + index * this.stepMm;
  }

  private obIndex(n: V3): number {
    const t = dot(sub(this.c, this.v0), n);
    return clamp(Math.round((t + this.ext(n)) / this.stepMm), 0, this.obCount(n) - 1);
  }

  private paneCount(plane: Plane): number {
    return this.rotated ? this.obCount(axesOf(this.frame, plane).n) : countOf(plane, this.g);
  }

  private paneIndex(plane: Plane): number {
    const g = this.g;
    if (this.rotated) return this.obIndex(axesOf(this.frame, plane).n);
    if (plane === "axial") return nearestZ(g.z, this.c[2]);
    if (plane === "coronal") return clamp(Math.round(this.c[1] / g.sy), 0, g.rows - 1);
    return clamp(Math.round(this.c[0] / g.sx), 0, g.cols - 1);
  }

  private sizeAt(scaleFactor: number): { w: number; h: number; p: number } {
    const p = this.p0 * scaleFactor;
    const s = Math.min(MAX_SIDE, Math.ceil(this.diag / p) + 2);
    return { w: s, h: s, p };
  }

  // Position of the crosshair in the image of a view, in pixels (centres at +0.5)
  private crossPos(plane: Plane): { x: number; y: number } {
    const g = this.g;
    const c = this.c;
    if (!this.rotated) {
      if (plane === "axial") return { x: c[0] / g.sx + 0.5, y: c[1] / g.sy + 0.5 };
      const y = (c[2] - this.z0) / zStep(plane, g) + 0.5;
      return plane === "coronal"
        ? { x: c[0] / g.sx + 0.5, y }
        : { x: c[1] / g.sy + 0.5, y };
    }
    const ax = axesOf(this.frame, plane);
    const sz = this.sizeAt(this.scaleNow);
    const centre = add(this.v0, scale(ax.n, this.tOf(ax.n, this.paneIndex(plane))));
    const d = sub(c, centre);
    return { x: dot(d, ax.u) / sz.p + sz.w / 2, y: dot(d, ax.v) / sz.p + sz.h / 2 };
  }

  private updateRefLines(): void {
    PLANES.forEach((plane, n) => {
      const pos = this.crossPos(plane);
      const [a, b] = AXIS_NAMES[plane];
      const lines: RefLine[] = [
        { axis: "x", pos: pos.x, color: COLOR[PLANE_OF_NORMAL[a]] },
        { axis: "y", pos: pos.y, color: COLOR[PLANE_OF_NORMAL[b]] },
      ];
      this.panes[n]?.setRefLines(lines);
    });
  }

  private refreshPanes(): void {
    PLANES.forEach((plane, n) => {
      this.panes[n]?.replaceSource(
        this.sourceFor(plane),
        this.paneCount(plane),
        this.paneIndex(plane),
      );
    });
    this.updateRefLines();
  }

  private refreshMip(): void {
    if (this.mip) this.extra.replaceSource(this.mipSource(), 1, 0);
  }

  // ---------- Image sources ----------

  private sourceFor(plane: Plane): SliceSource {
    return this.rotated ? this.obliqueSource(plane) : this.axisSource(plane);
  }

  // Planes parallel to the axes: exact voxel values, resampled only along the stack
  private axisSource(plane: Plane): SliceSource {
    const slab = { ...this.slab };
    const uid = this.series.uid;
    const ax = axesOf(identityFrame(), plane);
    const source: SliceSource = {
      id: `mpr:${uid}:${plane}:${slab.mode}:${slab.mode === "none" ? 0 : slab.mm}`,
      load: async (index): Promise<CachedSlice> => {
        const r = await getMprSlice(uid, plane, index, slab.mode, slab.mm);
        return { slice: r.slice, meta: this.metaFor(plane, ax, slab, r.spacing, "") };
      },
    };
    // A projection through everything looks the same at every position: compute it once
    if (covers(plane, this.g, slab)) source.canonical = () => 0;
    return source;
  }

  private obliqueSource(plane: Plane): SliceSource {
    const uid = this.series.uid;
    const ax = axesOf(this.frame, plane);
    const sz = this.sizeAt(this.scaleNow);
    const slab = { ...this.slab };
    const ext = this.ext(ax.n);
    const step = this.stepMm;
    const v0 = this.v0;
    return {
      id: `obl:${uid}:${plane}:${keyOf(ax)}:${slab.mode}:${slab.mode === "none" ? 0 : slab.mm}:${this.scaleNow}`,
      load: async (index): Promise<CachedSlice> => {
        const origin = add(v0, scale(ax.n, -ext + index * step));
        const r = await getObliqueSlice(
          uid, origin, ax.u, ax.v, sz.w, sz.h, sz.p, slab.mode, slab.mm, sz.p,
        );
        return { slice: r.slice, meta: this.metaFor(plane, ax, slab, r.spacing, "") };
      },
    };
  }

  private mipSource(): SliceSource {
    const uid = this.series.uid;
    const ax = this.mipAxes;
    const sz = this.sizeAt(this.mipScaleNow);
    const v0 = this.v0;
    const slab: Slab = { mode: "max", mm: FULL_MM };
    return {
      id: `mip:${uid}:${keyOf(ax)}:${this.mipScaleNow}`,
      load: async (): Promise<CachedSlice> => {
        const r = await getObliqueSlice(
          uid, v0, ax.u, ax.v, sz.w, sz.h, sz.p, "max", FULL_MM, sz.p,
        );
        return { slice: r.slice, meta: this.metaFor("coronal", ax, slab, r.spacing, " · 3D MIP") };
      },
    };
  }

  // ---------- Metadata ----------

  // Direction in patient space (LPS) of a direction in local volume coordinates
  private patient(v: V3): V3 | null {
    const o = this.volume.orientation;
    const z = this.volume.z_dir;
    if (!o) return null;
    if (Math.abs(v[2]) > 1e-9 && !z) return null;
    const cx: V3 = [o[0], o[1], o[2]];
    const cy: V3 = [o[3], o[4], o[5]];
    let out = add(scale(cx, v[0]), scale(cy, v[1]));
    if (z) out = add(out, scale(z, v[2]));
    return out;
  }

  private orientation(ax: Axes): SliceMeta["image_orientation"] {
    const u = this.patient(ax.u);
    const v = this.patient(ax.v);
    return u && v ? [u[0], u[1], u[2], v[0], v[1], v[2]] : null;
  }

  private title(plane: Plane, ax: Axes): string {
    const u = this.patient(ax.u);
    const v = this.patient(ax.v);
    if (u && v) return planeName(u, v);
    return plane === "axial" ? "Axial" : plane === "coronal" ? "Coronal" : "Sagittal";
  }

  // Metadata of a reformatted view: patient and study fields of the series, new geometry
  private metaFor(
    plane: Plane,
    ax: Axes,
    slab: Slab,
    spacing: [number, number],
    suffix: string,
  ): SliceMeta {
    const b = this.base ?? EMPTY_META;
    const name = b.series_description || this.series.description;
    const plain = plane === "axial" && slab.mode === "none" && !this.rotated && suffix === "";
    return {
      ...b,
      series_description: `${name} · ${this.title(plane, ax)}${slabText(slab)}${suffix}`,
      slice_location: null,
      slice_thickness: plain ? b.slice_thickness : null,
      // pixel_spacing is [row, column] = [vertical, horizontal]
      pixel_spacing: [spacing[1], spacing[0]],
      spacing_is_imager: false,
      image_orientation: this.orientation(ax),
      patient_orientation: "",
      cine_fps: null,
      frame: 0,
      frame_count: 1,
    };
  }
}