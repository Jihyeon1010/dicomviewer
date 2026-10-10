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