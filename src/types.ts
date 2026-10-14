export interface SeriesInfo {
  uid: string;
  description: string;
  slice_count: number; // Rust serde field names (snake_case) are kept as-is
}

export type PixelArray = Uint8Array | Int16Array | Uint16Array;

export interface SliceData {
  rows: number;
  cols: number;
  bitsAllocated: 8 | 16;
  signed: boolean;
  slope: number;
  intercept: number;
  defaultWl: number | null; // null when the file has no window attributes
  defaultWw: number | null;
  monochrome1: boolean;
  pixels: PixelArray;
}

// Mirrors the SliceMeta struct in lib.rs
export interface SliceMeta {
  patient_name: string;
  patient_id: string;
  patient_sex: string;
  patient_age: string;
  patient_birth_date: string;
  institution: string;
  study_description: string;
  study_date: string;
  study_time: string;
  series_description: string;
  series_number: string;
  modality: string;
  manufacturer_model: string;
  slice_location: number | null;
  slice_thickness: number | null;
  kvp: number | null;
  tube_current: number | null;
  pixel_spacing: [number, number] | null; // [row, column] in mm
  image_orientation: [number, number, number, number, number, number] | null;
  patient_orientation: string; // raw "row\column" codes, e.g. "L\F"
  frame: number;
  frame_count: number;
}