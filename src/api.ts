import { invoke } from "@tauri-apps/api/core";
import type { SeriesInfo, SliceData } from "./types";

const HEADER_BYTES = 40;

export function openFolder(dir: string): Promise<SeriesInfo[]> {
  return invoke<SeriesInfo[]>("open_folder", { dir });
}

// 파일과 폴더가 섞여 있어도 됩니다 (드래그 앤 드롭에서 사용)
export function openFiles(files: string[]): Promise<SeriesInfo[]> {
  return invoke<SeriesInfo[]>("open_files", { files });
}

export function selectSeries(uid: string): Promise<number> {
  return invoke<number>("select_series", { uid });
}

export async function getSlice(index: number): Promise<SliceData> {
  const buf = await invoke<ArrayBuffer>("get_slice", { index });
  return parseSlice(buf);
}

// 헤더 40바이트 (little-endian):
// [rows u32][cols u32][bits u32][signed u32]
// [slope f32][intercept f32][wc f32][ww f32][mono1 u32][pad u32]
function parseSlice(buf: ArrayBuffer): SliceData {
  if (buf.byteLength < HEADER_BYTES) {
    throw new Error(`슬라이스 응답이 너무 짧습니다 (${buf.byteLength} bytes)`);
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

  if (bits !== 8 && bits !== 16) {
    throw new Error(`지원하지 않는 BitsAllocated: ${bits}`);
  }
  const length = rows * cols;
  const expected = length * (bits / 8);
  const actual = buf.byteLength - HEADER_BYTES;
  if (actual < expected) {
    throw new Error(`픽셀 데이터 길이 불일치: 기대 ${expected}, 실제 ${actual}`);
  }

  const pixels =
    bits === 8
      ? new Uint8Array(buf, HEADER_BYTES, length)
      : signed
        ? new Int16Array(buf, HEADER_BYTES, length)
        : new Uint16Array(buf, HEADER_BYTES, length);

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
    pixels,
  };
}