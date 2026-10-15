import { getMprSlice } from "./api";
import { sliceCache, type CachedSlice, type SliceSource } from "./slice-cache";
import type { Pt } from "./transform2d";
import type { Plane, SeriesInfo, SlabMode, SliceMeta, VolumeInfo } from "./types";
import type { RefLine, Viewport } from "./viewport";

export const PLANES: Plane[] = ["axial", "coronal", "sagittal"];

export interface Slab {
  mode: SlabMode;
  mm: number; // thickness; ignored when mode is "none"
}

/** Thickness that reaches through the whole volume */
export const FULL_MM = 1e6;

type Vec3 = [number, number, number];

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
// The rules for sizes and spacing must match src-tauri/src/mpr.rs.

interface Geo {
  cols: number;
  rows: number;
  depth: number;
  sx: number; // mm between columns
  sy: number; // mm between rows
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

// ---------- Names ----------

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

// Anatomical name of the plane spanned by two direction vectors (patient LPS axes)
function planeName(a: Vec3, b: Vec3): string {
  const n = cross(a, b);
  const len = Math.hypot(n[0], n[1], n[2]);
  if (len < 1e-6) return "Oblique";
  const ax = Math.abs(n[0]) >= Math.abs(n[1]) && Math.abs(n[0]) >= Math.abs(n[2])
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

// ---------- Controller ----------

export interface MprOptions {
  panes: [Viewport, Viewport, Viewport]; // axial, coronal and sagittal view
  series: SeriesInfo;
  volume: VolumeInfo;
  baseMeta: SliceMeta | null; // patient and study fields come from here
}

/**
 * Three linked views of one volume. The crosshair position is a voxel (i, r, k): column,
 * row and image. The axial view scrolls k, the coronal view r and the sagittal view i.
 */
export class Mpr {
  readonly series: SeriesInfo;
  readonly panes: Viewport[];
  readonly pos = { i: 0, r: 0, k: 0 };

  private readonly volume: VolumeInfo;
  private readonly base: SliceMeta | null;
  private readonly g: Geo;
  private slab: Slab;

  constructor(opts: MprOptions, slab: Slab) {
    this.series = opts.series;
    this.panes = [...opts.panes];
    this.volume = opts.volume;
    this.base = opts.baseMeta;
    this.g = geoOf(opts.volume);
    this.slab = slab;
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
    const g = this.g;
    this.pos.i = Math.floor(g.cols / 2);
    this.pos.r = Math.floor(g.rows / 2);
    this.pos.k = Math.floor(g.depth / 2);

    const loads = PLANES.map((plane, n) => {
      const vp = this.panes[n];
      if (!vp) return Promise.resolve();
      return vp.setReformat(
        this.series,
        this.sourceFor(plane),
        countOf(plane, g),
        this.indexOf(plane),
        plane,
      );
    });
    this.updateRefLines();
    await Promise.all(loads);
  }

  stop(): void {
    for (const vp of this.panes) vp.setRefLines([]);
  }

  /** Changes the projection of all three views and keeps their positions and zoom. */
  setSlab(slab: Slab): void {
    this.slab = slab;
    PLANES.forEach((plane, n) => this.panes[n]?.replaceSource(this.sourceFor(plane)));
  }

  /** A view was scrolled: its coordinate of the crosshair follows. */
  scrolled(vp: Viewport): void {
    const plane = this.planeOf(vp);
    if (!plane) return;
    if (plane === "axial") this.pos.k = vp.index;
    else if (plane === "coronal") this.pos.r = vp.index;
    else this.pos.i = vp.index;
    this.updateRefLines();
  }

  /** The crosshair tool was used at `p` (image coordinates) of a view. */
  pick(vp: Viewport, p: Pt): void {
    const plane = this.planeOf(vp);
    if (!plane) return;
    const g = this.g;
    const col = (x: number): number => clamp(Math.floor(x), 0, g.cols - 1);
    const row = (y: number): number => clamp(Math.floor(y), 0, g.rows - 1);
    // Row j of a resampled view sits at z[0] + j * step, and pixel centres are at j + 0.5
    const image = (y: number): number =>
      nearestZ(g.z, (g.z[0] ?? 0) + (y - 0.5) * zStep(plane, g));

    if (plane === "axial") {
      this.pos.i = col(p.x);
      this.pos.r = row(p.y);
    } else if (plane === "coronal") {
      this.pos.i = col(p.x);
      this.pos.k = image(p.y);
    } else {
      this.pos.r = row(p.x);
      this.pos.k = image(p.y);
    }

    PLANES.forEach((other, n) => {
      if (other !== plane) this.panes[n]?.goto(this.indexOf(other), false, true);
    });
    this.updateRefLines();
  }

  // ---------- Internals ----------

  private indexOf(plane: Plane): number {
    return plane === "axial" ? this.pos.k : plane === "coronal" ? this.pos.r : this.pos.i;
  }

  private updateRefLines(): void {
    const g = this.g;
    const { i, r, k } = this.pos;
    const dz = (g.z[k] ?? 0) - (g.z[0] ?? 0);
    const yCoronal = dz / zStep("coronal", g) + 0.5;
    const ySagittal = dz / zStep("sagittal", g) + 0.5;

    const lines: Record<Plane, RefLine[]> = {
      axial: [
        { axis: "x", pos: i + 0.5, color: COLOR.sagittal },
        { axis: "y", pos: r + 0.5, color: COLOR.coronal },
      ],
      coronal: [
        { axis: "x", pos: i + 0.5, color: COLOR.sagittal },
        { axis: "y", pos: yCoronal, color: COLOR.axial },
      ],
      sagittal: [
        { axis: "x", pos: r + 0.5, color: COLOR.coronal },
        { axis: "y", pos: ySagittal, color: COLOR.axial },
      ],
    };
    PLANES.forEach((plane, n) => this.panes[n]?.setRefLines(lines[plane]));
  }

  private sourceFor(plane: Plane): SliceSource {
    const slab = { ...this.slab };
    const uid = this.series.uid;
    const full = covers(plane, this.g, slab);
    const source: SliceSource = {
      id: `mpr:${uid}:${plane}:${slab.mode}:${slab.mode === "none" ? 0 : slab.mm}`,
      load: async (index): Promise<CachedSlice> => {
        const r = await getMprSlice(uid, plane, index, slab.mode, slab.mm);
        return { slice: r.slice, meta: this.metaFor(plane, slab, r.spacing) };
      },
    };
    // A projection through everything looks the same at every position: compute it once
    if (full) source.canonical = () => 0;
    return source;
  }

  private orientation(plane: Plane): SliceMeta["image_orientation"] {
    const o = this.volume.orientation;
    const z = this.volume.z_dir;
    if (!o) return null;
    if (plane === "axial") return [o[0], o[1], o[2], o[3], o[4], o[5]];
    if (!z) return null;
    // Coronal: columns run along the image rows' direction; sagittal: along the columns'
    const [a, b, c] = plane === "coronal" ? [o[0], o[1], o[2]] : [o[3], o[4], o[5]];
    return [a as number, b as number, c as number, z[0], z[1], z[2]];
  }

  private title(plane: Plane): string {
    const o = this.volume.orientation;
    const z = this.volume.z_dir;
    const fallback = plane === "axial" ? "Axial" : plane === "coronal" ? "Coronal" : "Sagittal";
    if (!o) return fallback;
    const r: Vec3 = [o[0], o[1], o[2]];
    const c: Vec3 = [o[3], o[4], o[5]];
    if (plane === "axial") return planeName(r, c);
    if (!z) return fallback;
    return planeName(plane === "coronal" ? r : c, z);
  }

  // Metadata of a reformatted view: patient and study fields of the series, new geometry
  private metaFor(plane: Plane, slab: Slab, spacing: [number, number]): SliceMeta {
    const b = this.base ?? EMPTY_META;
    const name = b.series_description || this.series.description;
    return {
      ...b,
      series_description: `${name} · ${this.title(plane)}${slabText(slab)}`,
      slice_location: null,
      slice_thickness: plane === "axial" && slab.mode === "none" ? b.slice_thickness : null,
      // pixel_spacing is [row, column] = [vertical, horizontal]
      pixel_spacing: [spacing[1], spacing[0]],
      spacing_is_imager: false,
      image_orientation: this.orientation(plane),
      patient_orientation: "",
      cine_fps: null,
      frame: 0,
      frame_count: 1,
    };
  }
}

export { sliceCache }; // re-exported so callers that only deal with MPR need one import