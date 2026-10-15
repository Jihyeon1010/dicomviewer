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

/** One reformatted image of the built volume of a series. */
export async function getMprSlice(
  uid: string,
  plane: Plane,
  index: number,
  slab: SlabMode,
  thicknessMm: number,
): Promise<MprSlice> {
  const buf = await invoke<ArrayBuffer>("get_mpr_slice", { uid, plane, index, slab, thicknessMm });
  if (buf.byteLength < MPR_HEADER_BYTES) {
    throw new Error(`Reformatted image response too short (${buf.byteLength} bytes)`);
  }
  const dv = new DataView(buf);
  const spacing: [number, number] = [dv.getFloat32(40, true), dv.getFloat32(44, true)];
  return { slice: parseSlice(buf, MPR_HEADER_BYTES), spacing };
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