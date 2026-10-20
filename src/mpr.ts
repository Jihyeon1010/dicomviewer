import {
  exportMesh,
  getMprSlice,
  getObliqueSlice,
  getSurfaceMesh,
  getVolumeTexture,
  type MeshCoords,
  type SurfacePart,
  type SurfaceRequest,
} from "./api";
import type { CachedSlice, SliceSource } from "./slice-cache";
import { matrix, type Pt } from "./transform2d";
import type { Plane, SeriesInfo, SlabMode, SliceData, SliceMeta, VolumeInfo } from "./types";
import { add, cross, dot, rotateAbout, scale, sub, unit, type V3 } from "./vec3";
import type { RefLine, RefPolygon, Viewport } from "./viewport";
import { looksLikeHounsfield, presetForModality, transferFor, type ValueRange, type VrPresetId } from "./transfer";
import { VolumeGL, type ProjectionMode } from "./volume-gl";

export const PLANES: Plane[] = ["axial", "coronal", "sagittal"];

/** What the fourth view shows: a projection, a volume rendering or a surface (GPU only). */
export type View3d = ProjectionMode | "vr" | "surface";
export const VIEWS_3D: View3d[] = ["max", "min", "mean", "vr", "surface"];

export interface SurfaceSettings {
  threshold: number; // in the units of the volume (CT numbers for CT)
  maxThreshold: number | null; // voxels above this, such as bone, are left out; null for no limit
  smooth: number; // rounds of smoothing of the mesh
  part: SurfacePart;
  detail: number; // 0 = automatic, 1 = every voxel, 2 = every second voxel, ...
}

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
// Output scale of the 3D view at rest and while dragging (larger numbers mean coarser pixels).
// The CPU path needs coarse images to stay interactive; the GPU path does not.
const MIP_FINAL = 2;
const MIP_PREVIEW = 4;
const MIP_FINAL_GPU = 1;
const MIP_PREVIEW_GPU = 2;
// Most half-float volume data sent to the GPU; larger volumes are scaled down
const GPU_VOLUME_BYTES = 384 * 1024 * 1024;

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
  frame_time_ms: null,
  positioner_primary: null,
  positioner_secondary: null,
  intensity_relation: "",
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
  // Crosshair minus the centre of the oblique images, in the coordinates of the frame. The
  // centre turns with the frame about the crosshair, so the crosshair keeps its place on screen.
  private off: V3 = [0, 0, 0];
  private pivot3d: V3; // the point the 3D view is centred on and turns about
  private mipPending = false;
  private planesOn = true; // the planes of the MPR are outlined in the 3D view
  private view3d: View3d = "max";
  private vrPreset: VrPresetId;
  private vrThickMm = Infinity; // thickness of the volume drawn in the rendering
  private range: ValueRange;
  private surf: SurfaceSettings;
  private surfBuilt = ""; // the request that the mesh on the GPU was built for
  private surfRev = 0; // changes with every new mesh, for the image cache
  private surfTriangles = 0;
  private readonly lookAlong: 1 | -1;
  private mipScaleNow = MIP_FINAL;
  private gpu: VolumeGL | null = null; // the volume on the GPU, when it could be put there
  private gpuLoad: Promise<void> | null = null;
  private stopped = false;
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
    this.pivot3d = [...this.v0];
    const modality = opts.baseMeta?.modality ?? "";
    const { value_min, value_low: lo, value_high: hi } = opts.volume;
    this.vrPreset = presetForModality(modality, value_min);
    this.lookAlong = this.viewSide();
    const hounsfield = modality === "CT" && looksLikeHounsfield(value_min);
    this.surf = {
      threshold: hounsfield ? 300 : Math.round(lo + 0.5 * (hi - lo)),
      maxThreshold: null,
      smooth: 10,
      part: "largest",
      detail: 0,
    };
    this.range = {
      valueMin: opts.volume.value_min,
      valueMax: opts.volume.value_max,
      low: opts.volume.value_low,
      high: opts.volume.value_high,
      wl: null,
      ww: null,
    };
  }

  get view(): View3d {
    return this.view3d;
  }

  get preset(): VrPresetId {
    return this.vrPreset;
  }

  get surfaceSettings(): SurfaceSettings {
    return { ...this.surf };
  }

  /** Triangles of the surface on show, 0 before one was built. */
  get surfaceTriangles(): number {
    return this.surfTriangles;
  }

  get thicknessMm(): number {
    return this.vrThickMm;
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
    this.pivot3d = [...this.v0];
    this.off = [0, 0, 0];
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
    this.stopped = true;
    this.extra.setRefPolygons([]);
    this.gpu?.dispose();
    this.gpu = null;
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
    this.off = sub(this.c, this.v0);
    this.scaleNow = 1;
    this.refreshPanes();
    if (this.mip) {
      this.mipAxes = baseMipAxes();
      this.mipScaleNow = this.mipFinal;
      this.refreshMip();
    }
  }

  /** Turns the fourth view into a rotating 3D MIP, or back into the plain series. */
  setMipView(on: boolean): void {
    if (on === this.mip) return;
    this.mip = on;
    if (on) void this.startMip();
    else {
      void this.extra.setSeries(this.series);
      this.extra.setRefPolygons([]);
    }
  }

  /**
   * Projection of the 3D view: maximum, minimum or average intensity, or a volume rendering.
   * Resolves to false when the rendering is not possible (it needs WebGL2).
   */
  async setView3d(mode: View3d): Promise<boolean> {
    if (mode === "vr" || mode === "surface") {
      await this.ensureGpu();
      if (!this.gpu || this.stopped) return false;
      if (mode === "vr") this.applyTransfer();
      else await this.buildSurface(false);
      if (this.stopped) return false;
    }
    if (mode === this.view3d) {
      if (mode === "surface") this.refreshMip(); // the surface may be a new one
      return true;
    }
    this.view3d = mode;
    this.refreshMip();
    return true;
  }

  /**
   * Changes how the surface is built. Rebuilds it when it is on show; a failure is thrown
   * and the previous surface stays.
   */
  async setSurface(s: Partial<SurfaceSettings>): Promise<void> {
    const before = this.surf;
    this.surf = { ...before, ...s };
    try {
      if (this.view3d === "surface") await this.updateSurface();
    } catch (err) {
      this.surf = before; // the surface on show still has the old settings
      throw err;
    }
  }

  /** Builds the surface again, for example at a new position of the crosshair. */
  async updateSurface(): Promise<void> {
    await this.buildSurface(true);
    if (this.view3d === "surface" && !this.stopped) this.refreshMip();
  }

  /** Writes the surface as an STL, OBJ or PLY file; resolves to the number of triangles. */
  exportSurface(path: string, coords: MeshCoords): Promise<number> {
    return exportMesh(this.series.uid, this.surfaceRequest(), path, coords);
  }

  private surfaceRequest(): SurfaceRequest {
    const p = this.pos;
    return {
      threshold: this.surf.threshold,
      maxThreshold: this.surf.maxThreshold,
      smooth: this.surf.smooth,
      part: this.surf.part,
      seed: this.surf.part === "at" ? [p.i, p.r, p.k] : null,
      step: this.surf.detail,
    };
  }

  private async buildSurface(force: boolean): Promise<void> {
    await this.ensureGpu();
    const gpu = this.gpu;
    if (!gpu || this.stopped) throw new Error("The surface view needs WebGL2");
    const req = this.surfaceRequest();
    const key = JSON.stringify(req);
    if (!force && gpu.hasMesh && key === this.surfBuilt) return;
    const mesh = await getSurfaceMesh(this.series.uid, req);
    if (this.stopped) return;
    gpu.setMesh(mesh);
    this.surfBuilt = key;
    this.surfRev++;
    this.surfTriangles = mesh.indices.length / 3;
  }

  setVrPreset(id: VrPresetId): void {
    if (id === this.vrPreset) return;
    this.vrPreset = id;
    this.applyTransfer();
    if (this.view3d === "vr") this.refreshMip();
  }

  /** Thickness in mm of the part of the volume that the rendering draws; Infinity for all. */
  setVrThickness(mm: number): void {
    if (mm === this.vrThickMm) return;
    this.vrThickMm = mm;
    if (this.view3d === "vr" || this.view3d === "surface") this.refreshMip();
  }

  private applyTransfer(): void {
    this.gpu?.setTransferFunction(transferFor(this.vrPreset, this.range));
  }

  private get mipFinal(): number {
    return this.gpu ? MIP_FINAL_GPU : MIP_FINAL;
  }

  private get mipPreview(): number {
    return this.gpu ? MIP_PREVIEW_GPU : MIP_PREVIEW;
  }

  private async startMip(): Promise<void> {
    await this.ensureGpu();
    if (!this.mip || this.stopped) return; // switched off while the volume was loading
    this.pivot3d = [...this.c];
    this.mipAxes = baseMipAxes();
    this.mipScaleNow = this.mipFinal;
    await this.extra.setReformat(this.series, this.mipSource(), 1, 0, "coronal");
    this.updateOutlines();
  }

  // Puts the volume on the GPU once. When that fails the 3D view is computed by the backend.
  private ensureGpu(): Promise<void> {
    if (!this.gpuLoad) this.gpuLoad = this.loadGpu();
    return this.gpuLoad;
  }

  private async loadGpu(): Promise<void> {
    const gl = VolumeGL.open();
    if (!gl) return;
    try {
      const tex = await getVolumeTexture(this.series.uid, gl.maxDim, GPU_VOLUME_BYTES);
      if (this.stopped) {
        gl.dispose();
        return;
      }
      gl.upload(tex, this.z0);
      this.range = { ...this.range, wl: tex.defaultWl, ww: tex.defaultWw };
      this.gpu = gl;
    } catch (err) {
      console.warn("GPU rendering of the 3D view is unavailable, using the CPU path:", err);
      gl.dispose();
    }
  }

  // ---------- Crosshair ----------

  /** A view was scrolled: the crosshair follows along the normal of that view. */
  scrolled(vp: Viewport): void {
    const plane = this.planeOf(vp);
    if (!plane) return;
    const g = this.g;
    const c = this.c;
    let next: V3;
    if (this.rotated) {
      const n = axesOf(this.frame, plane).n;
      const t = this.tOf(n, vp.index);
      next = add(c, scale(n, t - dot(sub(c, this.v0), n)));
    } else if (plane === "axial") {
      next = [c[0], c[1], g.z[vp.index] ?? c[2]];
    } else if (plane === "coronal") {
      next = [c[0], vp.index * g.sy, c[2]];
    } else {
      next = [vp.index * g.sx, c[1], c[2]];
    }
    this.moveCrosshair(next);
    this.updateRefLines();
  }

  /** The crosshair tool was used at `p` (image coordinates) of a view. */
  pick(vp: Viewport, p: Pt): void {
    const plane = this.planeOf(vp);
    if (!plane) return;
    const g = this.g;

    let next: V3;
    if (this.rotated) {
      const ax = axesOf(this.frame, plane);
      const cp = this.crossPos(plane);
      const px = this.sizeAt(this.scaleNow).p;
      next = add(
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
      if (plane === "axial") next = [col(p.x) * g.sx, row(p.y) * g.sy, c[2]];
      else if (plane === "coronal") next = [col(p.x) * g.sx, c[1], g.z[image(p.y)] ?? c[2]];
      else next = [c[0], row(p.x) * g.sy, g.z[image(p.y)] ?? c[2]];
    }

    this.moveCrosshair([
      clamp(next[0], 0, (g.cols - 1) * g.sx),
      clamp(next[1], 0, (g.rows - 1) * g.sy),
      clamp(next[2], this.z0, this.zl),
    ]);
    PLANES.forEach((other, n) => {
      if (other !== plane) this.panes[n]?.goto(this.paneIndex(other), false, true);
    });
    this.updateRefLines();
    // The 3D view centres on the picked point and turns about it
    this.pivot3d = [...this.c];
    if (this.mip) this.queueMip();
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
      this.mipScaleNow = this.mipPreview;
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
      this.mipScaleNow = this.mipFinal;
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
      if (this.ball || this.mipPending) {
        this.mipPending = false;
        this.refreshMip();
      }
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

  // Images are square and must reach the whole volume from their centre, which can lie off
  // the middle of the volume; `slack` is how far. A coarser pixel keeps them within MAX_SIDE.
  private sizeAt(
    scaleFactor: number,
    slack = this.planeSlack(),
  ): { w: number; h: number; p: number } {
    const cover = this.diag + 2 * slack;
    const p = Math.max(this.p0 * scaleFactor, cover / (MAX_SIDE - 2));
    const s = Math.min(MAX_SIDE, Math.ceil(cover / p) + 2);
    return { w: s, h: s, p };
  }

  // Rounded up in steps, so that the size of the images changes rarely
  private quantized(mm: number): number {
    const q = this.diag / 8;
    return Math.ceil(mm / q - 1e-9) * q;
  }

  private planeSlack(): number {
    if (!this.rotated) return 0;
    return this.quantized(Math.hypot(...sub(this.c, this.v0)) + Math.hypot(...this.off));
  }

  private toFrame(w: V3): V3 {
    const f = this.frame;
    return [dot(w, f.x), dot(w, f.y), dot(w, f.z)];
  }

  // The point on which the oblique images are centred (each projected onto its plane)
  private viewCentre(): V3 {
    const f = this.frame;
    const o = this.off;
    return sub(this.c, add(add(scale(f.x, o[0]), scale(f.y, o[1])), scale(f.z, o[2])));
  }

  // Moves the crosshair and leaves the centre of the images where it is
  private moveCrosshair(next: V3): void {
    const centre = this.rotated ? this.viewCentre() : this.v0;
    this.c = next;
    this.off = this.toFrame(sub(next, centre));
  }

  private planeCentre(ax: Axes, index: number): V3 {
    const p0 = this.viewCentre();
    return add(p0, scale(ax.n, this.tOf(ax.n, index) - dot(sub(p0, this.v0), ax.n)));
  }

  private queueMip(): void {
    this.mipPending = true;
    this.dirty = true;
    this.schedule();
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
    const centre = this.planeCentre(ax, this.paneIndex(plane));
    const d = sub(c, centre);
    return { x: dot(d, ax.u) / sz.p + sz.w / 2, y: dot(d, ax.v) / sz.p + sz.h / 2 };
  }

  get showPlanes(): boolean {
    return this.planesOn;
  }

  setShowPlanes(on: boolean): void {
    this.planesOn = on;
    this.updateOutlines();
  }

  // The planes of the MPR (and the extent of a slab) as outlines in the 3D view. They are
  // given in millimetres from the middle of the image, which is the point the view turns about,
  // so they stay right whatever the resolution of the image that is on show.
  private updateOutlines(): void {
    if (!this.mip || !this.planesOn) {
      this.extra.setRefPolygons([]);
      return;
    }
    const ax = this.mipAxes;
    const pivot = this.pivot3d;
    const half = this.slab.mode !== "none" && this.slab.mm < FULL_MM / 10 ? this.slab.mm / 2 : 0;
    const polys: RefPolygon[] = [];
    for (const plane of PLANES) {
      const n = axesOf(this.frame, plane).n;
      for (const offset of half > 0 ? [-half, 0, half] : [0]) {
        const section = this.boxSection(add(this.c, scale(n, offset)), n);
        if (section.length < 3) continue;
        polys.push({
          pts: section.map((q) => {
            const d = sub(q, pivot);
            return { x: dot(d, ax.u), y: dot(d, ax.v) };
          }),
          color: COLOR[plane],
          dashed: offset !== 0,
        });
      }
    }
    this.extra.setRefPolygons(polys);
  }

  // The polygon in which the plane through `point` with normal `n` cuts the volume
  private boxSection(point: V3, n: V3): V3[] {
    const lo: V3 = [0, 0, this.z0];
    const hi: V3 = [(this.g.cols - 1) * this.g.sx, (this.g.rows - 1) * this.g.sy, this.zl];
    const corner = (i: number): V3 => [
      i & 1 ? hi[0] : lo[0],
      i & 2 ? hi[1] : lo[1],
      i & 4 ? hi[2] : lo[2],
    ];
    const pts: V3[] = [];
    for (let i = 0; i < 8; i++) {
      for (let bit = 0; bit < 3; bit++) {
        if (i & (1 << bit)) continue;
        const a = corner(i);
        const b = corner(i | (1 << bit));
        const edge = sub(b, a);
        const den = dot(n, edge);
        if (Math.abs(den) < 1e-12) continue;
        const t = dot(n, sub(point, a)) / den;
        if (t < -1e-9 || t > 1 + 1e-9) continue;
        const q = add(a, scale(edge, clamp(t, 0, 1)));
        if (!pts.some((o) => Math.hypot(o[0] - q[0], o[1] - q[1], o[2] - q[2]) < 1e-6)) pts.push(q);
      }
    }
    if (pts.length < 3) return [];
    // Order the corners around the middle, seen along the normal
    const mid: V3 = [0, 0, 0];
    for (const q of pts) {
      mid[0] += q[0] / pts.length;
      mid[1] += q[1] / pts.length;
      mid[2] += q[2] / pts.length;
    }
    const e1 = unit(cross(n, Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const e2 = cross(n, e1);
    const angle = (q: V3): number => Math.atan2(dot(sub(q, mid), e2), dot(sub(q, mid), e1));
    return pts.sort((p, q) => angle(p) - angle(q));
  }

  private updateRefLines(): void {
    this.updateOutlines();
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
    this.updateOutlines();
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
    const p0 = this.viewCentre();
    const centreKey = p0.map((x) => x.toFixed(2)).join(",");
    return {
      id: `obl:${uid}:${plane}:${keyOf(ax)}:${centreKey}:${slab.mode}:${slab.mode === "none" ? 0 : slab.mm}:${this.scaleNow}`,
      load: async (index): Promise<CachedSlice> => {
        const origin = add(p0, scale(ax.n, -ext + index * step - dot(sub(p0, v0), ax.n)));
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
    const pivot = this.pivot3d;
    const off = Math.hypot(...sub(pivot, this.v0));
    const sz = this.sizeAt(this.mipScaleNow, this.quantized(off));
    const gpu = this.gpu;
    const vr = this.view3d === "vr" && gpu !== null;
    const surf = this.view3d === "surface" && gpu !== null && gpu.hasMesh;
    // Without the GPU a rendering falls back to the maximum projection
    const mode: ProjectionMode =
      this.view3d === "vr" || this.view3d === "surface" ? "max" : this.view3d;
    const slab: Slab = vr || surf ? { mode: "none", mm: 0 } : { mode, mm: FULL_MM };
    const name = mode === "max" ? "MIP" : mode === "min" ? "MinIP" : "Average";
    const suffix = vr ? " · 3D Volume" : surf ? " · 3D Surface" : ` · 3D ${name}`;
    const thick = this.vrThickMm;
    const radius = this.diag * 0.55 + off;
    const lookAlong = this.lookAlong;
    const key = vr
      ? `vr:${this.vrPreset}:${thick}`
      : surf
        ? `surf:${this.surfRev}:${thick}`
        : `${gpu ? "gmip" : "mip"}:${mode}`;
    const pivotKey = pivot.map((x) => x.toFixed(1)).join(",");
    return {
      id: `${key}:${uid}:${keyOf(ax)}:${pivotKey}:${sz.w}:${this.mipScaleNow}`,
      load: async (): Promise<CachedSlice> => {
        let slice: SliceData | null = null;
        if (gpu?.ready) {
          try {
            const view = {
              origin: pivot,
              u: ax.u,
              v: ax.v,
              width: sz.w,
              height: sz.h,
              pixelMm: sz.p,
              stepMm: sz.p,
            };
            if (vr) {
              slice = gpu.render({ ...view, slabMm: thick, shade: true, centre: pivot, lookAlong });
            } else if (surf) {
              slice = gpu.drawMesh({ ...view, slabMm: thick, centre: pivot, radius, lookAlong });
            } else slice = gpu.project({ ...view, mode });
          } catch (err) {
            console.warn("GPU rendering failed, using the CPU path:", err);
          }
        }
        if (slice) {
          return { slice, meta: this.metaFor("coronal", ax, slab, [sz.p, sz.p], suffix) };
        }
        const r = await getObliqueSlice(
          uid, pivot, ax.u, ax.v, sz.w, sz.h, sz.p, mode, FULL_MM, sz.p,
        );
        return {
          slice: r.slice,
          meta: this.metaFor("coronal", ax, { mode, mm: FULL_MM }, r.spacing, ` · 3D ${name}`),
        };
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

  // The viewport turns the first image of the 3D view into the usual coronal picture (patient's
  // right on the left, superior on top). That picture is a true one only when the viewer looks
  // at the patient from the front, so the side from which volume renderings and surfaces are
  // seen follows from the patient axes: u x v must then point towards the posterior.
  private viewSide(): 1 | -1 {
    const base = baseMipAxes();
    const u = this.patient(base.u);
    const v = this.patient(base.v);
    if (!u || !v) return -1;
    return cross(u, v)[1] > 1e-6 ? 1 : -1;
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