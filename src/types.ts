export interface SeriesInfo {
  uid: string;
  description: string;
  slice_count: number; 
}

export type PixelArray = Uint8Array | Int16Array | Uint16Array;

export interface SliceData {
  rows: number;
  cols: number;
  bitsAllocated: 8 | 16;
  signed: boolean;
  pixels: PixelArray;
}

export interface ViewState {
  count: number;
  index: number;
  wl: number;
  ww: number;
}

export interface SeriesInfo {
  uid: string;
  description: string;
  slice_count: number; // Rust serde 필드명(snake_case) 그대로
}
export interface SliceData {
  rows: number;
  cols: number;
  bitsAllocated: 8 | 16;
  signed: boolean;
  slope: number;
  intercept: number;
  defaultWl: number | null; // 파일에 없으면 null
  defaultWw: number | null;
  monochrome1: boolean;
  pixels: PixelArray;
}