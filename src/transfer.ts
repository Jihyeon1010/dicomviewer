/** Colour and opacity as a function of the voxel value, for volume rendering. */
export interface TransferFunction {
  /** RGBA, LUT_SIZE entries (not premultiplied). The alpha is the opacity of 1 mm of material. */
  lut: Uint8Array;
  lo: number; // value at the first entry
  hi: number; // value at the last entry
}

export const LUT_SIZE = 1024;

export type VrPresetId = "generic" | "bone" | "vessel" | "soft";

export const VR_PRESETS: { id: VrPresetId; label: string }[] = [
  { id: "generic", label: "Generic" },
  { id: "bone", label: "Bone" },
  { id: "vessel", label: "Vessels (CTA)" },
  { id: "soft", label: "Soft tissue" },
];

/** What the preset may need to know about the data. */
export interface ValueRange {
  valueMin: number;
  valueMax: number;
  wl: number | null; // default window of the series
  ww: number | null;
}

interface Stop {
  v: number; // value (CT number for the CT presets)
  c: [number, number, number]; // colour, 0 to 1
  a: number; // opacity of 1 mm of material, 0 to 1
}

// CT numbers are tabulated over the usual range; values outside it use the end stops
const CT_LO = -1024;
const CT_HI = 3072;

const BONE: Stop[] = [
  { v: 150, c: [0.89, 0.85, 0.79], a: 0 },
  { v: 300, c: [0.89, 0.85, 0.79], a: 0.1 },
  { v: 700, c: [0.95, 0.92, 0.86], a: 0.45 },
  { v: 1500, c: [1, 0.98, 0.94], a: 0.8 },
  { v: CT_HI, c: [1, 1, 1], a: 0.9 },
];

// Contrast-filled vessels stand out; bone is kept nearly transparent so it does not hide them
const VESSEL: Stop[] = [
  { v: 100, c: [0.75, 0.1, 0.1], a: 0 },
  { v: 180, c: [0.75, 0.1, 0.1], a: 0.05 },
  { v: 300, c: [0.9, 0.25, 0.15], a: 0.35 },
  { v: 500, c: [0.98, 0.5, 0.3], a: 0.55 },
  { v: 700, c: [0.95, 0.92, 0.86], a: 0.03 },
  { v: CT_HI, c: [0.95, 0.92, 0.86], a: 0.05 },
];

const SOFT: Stop[] = [
  { v: -400, c: [0.8, 0.55, 0.45], a: 0 },
  { v: -100, c: [0.8, 0.55, 0.45], a: 0.15 },
  { v: 60, c: [0.85, 0.6, 0.5], a: 0.35 },
  { v: 200, c: [0.9, 0.75, 0.65], a: 0.5 },
  { v: 400, c: [1, 0.95, 0.9], a: 0.8 },
  { v: CT_HI, c: [1, 1, 1], a: 0.9 },
];

/** Grey ramp over the window of the series (or the upper part of the value range). */
function genericStops(r: ValueRange): Stop[] {
  const span = Math.max(1e-6, r.valueMax - r.valueMin);
  const lo = r.wl !== null && r.ww !== null ? r.wl - r.ww / 2 : r.valueMin + 0.15 * span;
  const hi = r.wl !== null && r.ww !== null ? r.wl + r.ww / 2 : r.valueMax;
  const mid = (lo + hi) / 2;
  return [
    { v: lo, c: [0.2, 0.2, 0.2], a: 0 },
    { v: mid, c: [0.7, 0.7, 0.7], a: 0.05 },
    { v: Math.max(hi, mid + 1e-6), c: [1, 1, 1], a: 0.25 },
  ];
}

function interpolate(stops: Stop[], v: number): { c: [number, number, number]; a: number } {
  const first = stops[0] as Stop;
  const last = stops[stops.length - 1] as Stop;
  if (v <= first.v) return { c: first.c, a: first.a };
  if (v >= last.v) return { c: last.c, a: last.a };
  for (let i = 1; i < stops.length; i++) {
    const s1 = stops[i] as Stop;
    if (v <= s1.v) {
      const s0 = stops[i - 1] as Stop;
      const t = (v - s0.v) / Math.max(1e-9, s1.v - s0.v);
      return {
        c: [
          s0.c[0] + (s1.c[0] - s0.c[0]) * t,
          s0.c[1] + (s1.c[1] - s0.c[1]) * t,
          s0.c[2] + (s1.c[2] - s0.c[2]) * t,
        ],
        a: s0.a + (s1.a - s0.a) * t,
      };
    }
  }
  return { c: last.c, a: last.a };
}

export function transferFor(id: VrPresetId, range: ValueRange): TransferFunction {
  const ct = id !== "generic";
  const stops = id === "bone" ? BONE : id === "vessel" ? VESSEL : id === "soft" ? SOFT : genericStops(range);
  const lo = ct ? CT_LO : range.valueMin;
  const hi = ct ? CT_HI : Math.max(range.valueMax, range.valueMin + 1e-6);
  const lut = new Uint8Array(LUT_SIZE * 4);
  for (let i = 0; i < LUT_SIZE; i++) {
    const { c, a } = interpolate(stops, lo + ((hi - lo) * i) / (LUT_SIZE - 1));
    lut[i * 4] = Math.round(c[0] * 255);
    lut[i * 4 + 1] = Math.round(c[1] * 255);
    lut[i * 4 + 2] = Math.round(c[2] * 255);
    lut[i * 4 + 3] = Math.round(a * 255);
  }
  return { lut, lo, hi };
}
