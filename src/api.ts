import { invoke } from "@tauri-apps/api/core";
import type {
  Plane,
  SeriesGeometry,
  SeriesInfo,
  SlabMode,
  SliceData,
  SliceMeta,
  TagEntry,
  VolumeInfo,
} from "./types";

import type { V3 } from "./vec3";

const HEADER_BYTES = 40;
const MPR_HEADER_BYTES = 48;
const THUMB_HEADER_BYTES = 12;

export function openFolder(dir: string): Promise<SeriesInfo[]> {
  return invoke<SeriesInfo[]>("open_folder", { dir });
}

// Files and folders may be mixed (used by drag and drop)
export function openFiles(files: string[]): Promise<SeriesInfo[]> {
  return invoke<SeriesInfo[]>("open_files", { files });
}

export function getSeriesGeometry(uid: string): Promise<SeriesGeometry> {
  return invoke<SeriesGeometry>("get_series_geometry", { uid });
}

export function getSliceMeta(uid: string, index: number): Promise<SliceMeta> {
  return invoke<SliceMeta>("get_slice_meta", { uid, index });
}

export async function getSlice(uid: string, index: number): Promise<SliceData> {
  const buf = await invoke<ArrayBuffer>("get_slice", { uid, index });
  return parseSlice(buf);
}

// Header (little-endian), 40 bytes:
// [rows u32][cols u32][bits u32][signed u32]
// [slope f32][intercept f32][wc f32][ww f32][mono1 u32][samples u32]
// followed by the pixels: 8/16-bit grayscale, or 8-bit interleaved RGB when samples is 3.
// Reformatted images use a 48-byte header: the same 40 bytes plus two spacing values.
function parseSlice(buf: ArrayBuffer, headerBytes = HEADER_BYTES): SliceData {
  if (buf.byteLength < headerBytes) {
    throw new Error(`Slice response too short (${buf.byteLength} bytes)`);
  }
  const dv = new DataView(buf);
  const rows = dv.getUint32(0, true);
  const cols = dv.getUint32(4, true);
  const bits = dv.getUint32(8, true);
  const signed = dv.getUint32(12, true) === 1;
  const slope = dv.getFloat32(16, true);
  const intercept = dv.getFloat32(20, true);
  const wc = dv.getFloat32(24, true);
  const ww = dv.getFloat32(28, true);
  const monochrome1 = dv.getUint32(32, true) === 1;
  const samplesRaw = dv.getUint32(36, true);

  if (bits !== 8 && bits !== 16) {
    throw new Error(`Unsupported BitsAllocated: ${bits}`);
  }
  if (samplesRaw !== 1 && samplesRaw !== 3) {
    throw new Error(`Unsupported samples per pixel: ${samplesRaw}`);
  }
  if (samplesRaw === 3 && bits !== 8) {
    throw new Error("Colour images must be 8-bit");
  }
  const samples: 1 | 3 = samplesRaw === 3 ? 3 : 1;

  const length = rows * cols * samples;
  const expected = length * (bits / 8);
  const actual = buf.byteLength - headerBytes;
  if (actual < expected) {
    throw new Error(`Pixel data length mismatch: expected ${expected}, got ${actual}`);
  }

  const pixels =
    bits === 8
      ? new Uint8Array(buf, headerBytes, length)
      : signed
        ? new Int16Array(buf, headerBytes, length)
        : new Uint16Array(buf, headerBytes, length);

  return {
    rows,
    cols,
    bitsAllocated: bits,
    signed,
    slope: slope || 1,
    intercept,
    defaultWl: Number.isFinite(wc) ? wc : null,
    defaultWw: Number.isFinite(ww) && ww > 0 ? ww : null,
    monochrome1,
    samples,
    pixels,
  };
}

export interface MprSlice {
  slice: SliceData;
  spacing: [number, number]; // mm per output pixel: [horizontal, vertical]
}

function parseMpr(buf: ArrayBuffer): MprSlice {
  if (buf.byteLength < MPR_HEADER_BYTES) {
    throw new Error(`Reformatted image response too short (${buf.byteLength} bytes)`);
  }
  const dv = new DataView(buf);
  const spacing: [number, number] = [dv.getFloat32(40, true), dv.getFloat32(44, true)];
  return { slice: parseSlice(buf, MPR_HEADER_BYTES), spacing };
}

/** One reformatted image of the built volume of a series. */
export async function getMprSlice(
  uid: string,
  plane: Plane,
  index: number,
  slab: SlabMode,
  thicknessMm: number,
): Promise<MprSlice> {
  const buf = await invoke<ArrayBuffer>("get_mpr_slice", { uid, plane, index, slab, thicknessMm });
  return parseMpr(buf);
}

/**
 * An image on an arbitrary plane (through `origin`, spanned by the unit vectors u and v),
 * or a projection along its normal. Coordinates are local millimetres of the volume.
 */
export async function getObliqueSlice(
  uid: string,
  origin: V3,
  u: V3,
  v: V3,
  width: number,
  height: number,
  pixelMm: number,
  slab: SlabMode,
  thicknessMm: number,
  rayStepMm: number,
): Promise<MprSlice> {
  const buf = await invoke<ArrayBuffer>("get_oblique_slice", {
    uid, origin, u, v, width, height, pixelMm, slab, thicknessMm, rayStepMm,
  });
  return parseMpr(buf);
}

/** The volume of a series as half floats for the GPU, possibly scaled down. */
export interface VolumeTexture {
  cols: number;
  rows: number;
  depth: number;
  slope: number; // raw 16-bit encoding of rendered images: value = raw * slope + intercept
  intercept: number;
  extent: V3; // mm between the first and last voxel centre along x, y and z
  valueMin: number;
  defaultWl: number | null;
  defaultWw: number | null;
  monochrome1: boolean;
  data: Uint16Array; // half float bits, x fastest, then y, then z
}

const TEXTURE_HEADER_BYTES = 48;

export async function getVolumeTexture(
  uid: string,
  maxDim: number,
  maxBytes: number,
): Promise<VolumeTexture> {
  const buf = await invoke<ArrayBuffer>("get_volume_texture", { uid, maxDim, maxBytes });
  if (buf.byteLength < TEXTURE_HEADER_BYTES) {
    throw new Error(`Volume response too short (${buf.byteLength} bytes)`);
  }
  const dv = new DataView(buf);
  const cols = dv.getUint32(0, true);
  const rows = dv.getUint32(4, true);
  const depth = dv.getUint32(8, true);
  const count = cols * rows * depth;
  if (count === 0 || buf.byteLength - TEXTURE_HEADER_BYTES < count * 2) {
    throw new Error(`Volume size mismatch: ${cols}x${rows}x${depth}, ${buf.byteLength} bytes`);
  }
  const wc = dv.getFloat32(36, true);
  const ww = dv.getFloat32(40, true);
  return {
    cols,
    rows,
    depth,
    slope: dv.getFloat32(12, true),
    intercept: dv.getFloat32(16, true),
    extent: [dv.getFloat32(20, true), dv.getFloat32(24, true), dv.getFloat32(28, true)],
    valueMin: dv.getFloat32(32, true),
    defaultWl: Number.isFinite(wc) ? wc : null,
    defaultWw: Number.isFinite(ww) && ww > 0 ? ww : null,
    monochrome1: dv.getUint32(44, true) === 1,
    data: new Uint16Array(buf, TEXTURE_HEADER_BYTES, count),
  };
}

export type SurfacePart = "all" | "largest" | "at";

/** Which surface to build: where the volume crosses `threshold`, and which parts of it. */
export interface SurfaceRequest {
  threshold: number;
  maxThreshold: number | null; // voxels above this (bone) are left out, with a voxel around them
  smooth: number; // rounds of smoothing of the mesh, 0 for none
  part: SurfacePart;
  seed: [number, number, number] | null; // column, row and image to grow the part from, for "at"
  step: number; // sample every n-th voxel; 0 chooses automatically
}

export interface SurfaceMesh {
  positions: Float32Array; // x, y, z per vertex in the local millimetre coordinates of the volume
  normals: Float32Array;
  indices: Uint32Array;
  step: number; // sampling that was used
}

const MESH_HEADER_BYTES = 16;

export async function getSurfaceMesh(uid: string, req: SurfaceRequest): Promise<SurfaceMesh> {
  const buf = await invoke<ArrayBuffer>("get_surface_mesh", { uid, ...req });
  if (buf.byteLength < MESH_HEADER_BYTES) {
    throw new Error(`Surface response too short (${buf.byteLength} bytes)`);
  }
  const dv = new DataView(buf);
  const nv = dv.getUint32(0, true);
  const nt = dv.getUint32(4, true);
  if (buf.byteLength - MESH_HEADER_BYTES < nv * 24 + nt * 12) {
    throw new Error(`Surface size mismatch: ${nv} vertices, ${nt} triangles, ${buf.byteLength} bytes`);
  }
  return {
    positions: new Float32Array(buf, MESH_HEADER_BYTES, nv * 3),
    normals: new Float32Array(buf, MESH_HEADER_BYTES + nv * 12, nv * 3),
    indices: new Uint32Array(buf, MESH_HEADER_BYTES + nv * 24, nt * 3),
    step: dv.getUint32(8, true),
  };
}

/** Writes the surface as a binary STL file (millimetres); returns the number of triangles. */
export function exportStl(uid: string, req: SurfaceRequest, path: string): Promise<number> {
  return invoke<number>("export_stl", { uid, ...req, path });
}

// Response (little-endian): [width u32][height u32][channels u32][width*height*channels bytes]
// channels is 1 (8-bit gray) or 3 (8-bit RGB)
export async function getThumbnail(uid: string, maxPx: number): Promise<ImageData> {
  const buf = await invoke<ArrayBuffer>("get_thumbnail", { uid, maxPx });
  if (buf.byteLength < THUMB_HEADER_BYTES) {
    throw new Error(`Thumbnail response too short (${buf.byteLength} bytes)`);
  }
  const dv = new DataView(buf);
  const w = dv.getUint32(0, true);
  const h = dv.getUint32(4, true);
  const channels = dv.getUint32(8, true);
  if (channels !== 1 && channels !== 3) {
    throw new Error(`Unsupported thumbnail channel count: ${channels}`);
  }
  if (w === 0 || h === 0 || buf.byteLength - THUMB_HEADER_BYTES < w * h * channels) {
    throw new Error(`Thumbnail size mismatch: ${w}x${h}x${channels}, ${buf.byteLength} bytes`);
  }

  // Expand to RGBA for ImageData
  const src = new Uint8Array(buf, THUMB_HEADER_BYTES, w * h * channels);
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    if (channels === 1) {
      const g = src[i] as number;
      rgba[o] = g;
      rgba[o + 1] = g;
      rgba[o + 2] = g;
    } else {
      const j = i * 3;
      rgba[o] = src[j] as number;
      rgba[o + 1] = src[j + 1] as number;
      rgba[o + 2] = src[j + 2] as number;
    }
    rgba[o + 3] = 255;
  }
  return new ImageData(rgba, w, h);
}

// Builds the in-memory volume of a series. The Rust side keeps it for later use.
export function buildVolume(uid: string): Promise<VolumeInfo> {
  return invoke<VolumeInfo>("build_volume", { uid });
}

export function getTags(uid: string, index: number): Promise<TagEntry[]> {
  return invoke<TagEntry[]>("get_tags", { uid, index });
}

// Raw body: [path length u32 LE][path, UTF-8][PNG bytes]
export async function savePng(path: string, png: Uint8Array): Promise<void> {
  const p = new TextEncoder().encode(path);
  const payload = new Uint8Array(4 + p.length + png.length);
  new DataView(payload.buffer).setUint32(0, p.length, true);
  payload.set(p, 4);
  payload.set(png, 4 + p.length);
  await invoke("save_png", payload);
}