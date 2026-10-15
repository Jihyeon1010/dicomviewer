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
  samples: 1 | 3; // 1 = grayscale, 3 = RGB (8-bit, interleaved)
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
  spacing_is_imager: boolean; // spacing comes from ImagerPixelSpacing (approximate)
  cine_fps: number | null;    // playback rate stored in the file
}

// Mirrors the VolumeInfo struct in lib.rs
export interface VolumeInfo {
  cols: number;
  rows: number;
  depth: number;
  pixel_spacing: [number, number] | null; // [row, column] in mm
  slice_spacing: number | null;           // mean distance between slices in mm
  uniform: boolean;                       // false when the spacing varies by more than 1%
  tilt_deg: number;                       // gantry tilt
  value_min: number;
  value_max: number;
  megabytes: number;
  z_positions: number[];                  // mm along the stack direction, one per image
  orientation: [number, number, number, number, number, number] | null; // row and column cosines
  z_dir: [number, number, number] | null; // direction in which the image index increases
}

export type Plane = "axial" | "coronal" | "sagittal";
export type SlabMode = "none" | "max" | "min" | "mean";

// Mirrors the SeriesGeometry struct in lib.rs
export interface SeriesGeometry {
  frame_of_reference: string;
  normal: [number, number, number] | null;
  positions: number[] | null; // mm along the normal, one per image, ascending
}

// Mirrors the TagEntry struct in lib.rs
export interface TagEntry {
  depth: number;
  tag: string;   // "(0008,0060)"
  name: string;
  vr: string;
  value: string;
}