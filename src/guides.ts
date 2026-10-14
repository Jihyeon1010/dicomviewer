import type { SliceMeta } from "./types";

export interface EdgeLabels {
  left: string;
  right: string;
  top: string;
  bottom: string;
}

export interface ScaleBar {
  px: number; // bar length on screen, in whole CSS pixels
  label: string;
  divisions: number; // number of tick intervals along the bar
}

type Vec3 = [number, number, number];

// DICOM patient coordinates are LPS: +x = Left, +y = Posterior, +z = Superior
const AXES: { pos: string; neg: string }[] = [
  { pos: "L", neg: "R" },
  { pos: "P", neg: "A" },
  { pos: "S", neg: "I" },
];

// Anatomical letters for a direction vector: the dominant axis always, and the
// next one only if it is clearly present (so oblique planes read e.g. "AR").
function dirLabel(v: Vec3): string {
  return v
    .map((a, i) => ({ a, i }))
    .sort((p, q) => Math.abs(q.a) - Math.abs(p.a))
    .slice(0, 2)
    .filter((x, rank) => rank === 0 || Math.abs(x.a) >= 0.2)
    .map(({ a, i }) => {
      const axis = AXES[i];
      if (!axis) return "";
      return a >= 0 ? axis.pos : axis.neg;
    })
    .join("");
}

const negate = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]];

const OPPOSITE: Record<string, string> = { L: "R", R: "L", A: "P", P: "A", S: "I", I: "S" };

// PatientOrientation uses H (head) / F (foot); show S / I like the vector case
const normalizeCodes = (s: string): string =>
  [...s].map((c) => (c === "H" ? "S" : c === "F" ? "I" : c)).join("");

const oppositeCodes = (s: string): string =>
  [...s].map((c) => OPPOSITE[c] ?? c).join("");

/**
 * Anatomical labels for the four edges of the image as stored (no rotation or flip).
 * Returns null when the file carries no orientation information.
 */
export function edgeLabels(m: SliceMeta | null): EdgeLabels | null {
  if (!m) return null;

  const o = m.image_orientation;
  if (o) {
    // First three values: direction of increasing column index (screen right).
    // Last three: direction of increasing row index (screen down).
    const right: Vec3 = [o[0], o[1], o[2]];
    const down: Vec3 = [o[3], o[4], o[5]];
    return {
      right: dirLabel(right),
      left: dirLabel(negate(right)),
      bottom: dirLabel(down),
      top: dirLabel(negate(down)),
    };
  }

  // Projection images: "row\column" codes, e.g. "L\F"
  const [r, c] = m.patient_orientation.split("\\").map((s) => s.trim());
  if (r && c) {
    const right = normalizeCodes(r);
    const down = normalizeCodes(c);
    return {
      right,
      left: oppositeCodes(right),
      bottom: down,
      top: oppositeCodes(down),
    };
  }
  return null;
}

function formatLength(mm: number): string {
  return mm >= 10 ? `${+(mm / 10).toFixed(2)} cm` : `${+mm.toFixed(3)} mm`;
}

// Tick intervals per bar length (1, 2 or 5 x 10^n mm). Every choice keeps
// the tick spacing at 8 px or more for bars of at least 80 px.
const DIVISIONS: Record<number, number> = { 1: 10, 2: 4, 5: 5 };

/** Picks a round length (1, 2 or 5 x 10^n mm) that is 80-200 px wide on screen. */
export function scaleBar(pxPerMm: number): ScaleBar | null {
  if (!Number.isFinite(pxPerMm) || pxPerMm <= 0) return null;

  let base = Math.pow(10, Math.floor(Math.log10(60 / pxPerMm)));
  for (let decade = 0; decade < 3; decade++, base *= 10) {
    for (const k of [1, 2, 5]) {
      const mm = base * k;
      const px = mm * pxPerMm;
      if (px >= 80) {
        return { px: Math.round(px), label: formatLength(mm), divisions: DIVISIONS[k] ?? 5 };
      }
    }
  }
  return null;
}

export const SCALE_BAR_HEIGHT = 12; // SVG height in CSS pixels

// Tick heights: full at both ends, medium at the midpoint, short elsewhere
function tickHeight(i: number, n: number): number {
  if (i === 0 || i === n) return 10;
  if (n % 2 === 0 && i === n / 2) return 7;
  return 4;
}

/**
 * SVG path data for the ruler: a baseline plus tick marks. The SVG should be
 * `px + 2` wide so that the 2 px strokes at both ends are not clipped.
 */
export function scaleBarPath(bar: ScaleBar): string {
  const y = SCALE_BAR_HEIGHT - 1; // baseline; the 2 px stroke covers y-1 .. y+1
  const parts = [`M1 ${y}H${bar.px + 1}`];
  for (let i = 0; i <= bar.divisions; i++) {
    const x = Math.round(1 + (i * bar.px) / bar.divisions); // whole pixels keep the strokes crisp
    parts.push(`M${x} ${y}V${y - tickHeight(i, bar.divisions)}`);
  }
  return parts.join("");
}

/**
 * SVG path data for the vertical ruler: a baseline on the left plus ticks
 * pointing right. The SVG should be `SCALE_BAR_HEIGHT` wide and `px + 2` tall.
 */
export function scaleBarPathVertical(bar: ScaleBar): string {
  const parts = [`M1 1V${bar.px + 1}`];
  for (let i = 0; i <= bar.divisions; i++) {
    const y = Math.round(1 + (i * bar.px) / bar.divisions); // whole pixels keep the strokes crisp
    parts.push(`M1 ${y}H${1 + tickHeight(i, bar.divisions)}`);
  }
  return parts.join("");
}