import { invoke } from "@tauri-apps/api/core";
import type { PixelArray, SeriesInfo, SliceData } from "./types";

const HEADER_BYTES = 16;

export function openFolder(dir: string): Promise<SeriesInfo[]> {
  return invoke<SeriesInfo[]>("open_folder", { dir });
}

export function selectSeries(uid: string): Promise<number> {
  return invoke<number>("select_series", { uid });
}

export async function getSlice(index: number): Promise<SliceData> {
  const buf = await invoke<ArrayBuffer>("get_slice", { index });
  return parseSlice(buf);
}

function parseSlice(buf: ArrayBuffer): SliceData {
  if (buf.byteLength < HEADER_BYTES) {
    throw new Error(`slice response is too short (${buf.byteLength} bytes)`);
  }
  const dv = new DataView(buf);
  const rows = dv.getUint32(0, true);
  const cols = dv.getUint32(4, true);
  const bits = dv.getUint32(8, true);
  const signed = dv.getUint32(12, true) === 1;

  if (bits !== 8 && bits !== 16) {
    throw new Error(`unsupported BitsAllocated: ${bits}`);
  }
  const bytesPerPixel = bits / 8;
  const expected = rows * cols * bytesPerPixel;
  const actual = buf.byteLength - HEADER_BYTES;
  if (actual < expected) {
    throw new Error(`pixel data length mismatch: expected ${expected}, got ${actual}`);
  }

  const length = rows * cols;
  let pixels: PixelArray;
  if (bits === 8) {
    pixels = new Uint8Array(buf, HEADER_BYTES, length);
  } else {
    pixels = signed
      ? new Int16Array(buf, HEADER_BYTES, length)
      : new Uint16Array(buf, HEADER_BYTES, length);
  }
  return { rows, cols, bitsAllocated: bits, signed, pixels };
}