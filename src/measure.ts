import { num } from "./format";
import type { Pt } from "./transform2d";
import type { SliceData } from "./types";

export interface Spacing {
  row: number;     // mm between rows (vertical step)
  col: number;     // mm between columns (horizontal step)
  approx: boolean; // detector-plane spacing: lengths are only approximate
}

const approxMark = (sp: Spacing | null): string => (sp?.approx ? "≈ " : "");

export function lengthText(a: Pt, b: Pt, sp: Spacing | null): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (!sp) return `${num(Math.hypot(dx, dy), 1)} px`;
  const mm = Math.hypot(dx * sp.col, dy * sp.row);
  return `${approxMark(sp)}${mm >= 100 ? `${num(mm / 10, 2)} cm` : `${num(mm, 1)} mm`}`;
}

/** Angle at p2 between p1 and p3, measured in millimetres when the spacing is known. */
export function angleText(p1: Pt, p2: Pt, p3: Pt, sp: Spacing | null): string | null {
  const kx = sp ? sp.col : 1;
  const ky = sp ? sp.row : 1;
  const ux = (p1.x - p2.x) * kx;
  const uy = (p1.y - p2.y) * ky;
  const vx = (p3.x - p2.x) * kx;
  const vy = (p3.y - p2.y) * ky;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (lu < 1e-9 || lv < 1e-9) return null;
  const cos = Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)));
  return `${num((Math.acos(cos) * 180) / Math.PI, 1)}°`;
}

export function shapeAreaPx(kind: "ellipse" | "rect", a: Pt, b: Pt): number {
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  return kind === "rect" ? w * h : (Math.PI * w * h) / 4;
}

export function areaText(areaPx: number, sp: Spacing | null): string {
  if (!sp) return `${num(areaPx, 0)} px²`;
  const mm2 = areaPx * sp.row * sp.col;
  const body = mm2 >= 100 ? `${num(mm2 / 100, 2)} cm²` : `${num(mm2, 1)} mm²`;
  return `${approxMark(sp)}${body}`;
}

/** Area plus, for grayscale images, statistics of the values inside the shape. */
export function roiLines(
  kind: "ellipse" | "rect",
  a: Pt,
  b: Pt,
  s: SliceData,
  sp: Spacing | null,
  modality: string,
): string[] {
  const lines = [`Area ${areaText(shapeAreaPx(kind, a, b), sp)}`];
  if (s.samples !== 1) return lines;

  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rx = (x1 - x0) / 2;
  const ry = (y1 - y0) / 2;

  let n = 0;
  let sum = 0;
  let sumSq = 0;
  let min = Infinity;
  let max = -Infinity;

  const xs = Math.max(0, Math.floor(x0));
  const xe = Math.min(s.cols - 1, Math.ceil(x1));
  const ys = Math.max(0, Math.floor(y0));
  const ye = Math.min(s.rows - 1, Math.ceil(y1));
  for (let y = ys; y <= ye; y++) {
    const py = y + 0.5; // pixel centers decide membership
    for (let x = xs; x <= xe; x++) {
      const px = x + 0.5;
      const inside =
        kind === "rect"
          ? px >= x0 && px <= x1 && py >= y0 && py <= y1
          : rx > 0 && ry > 0 && ((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1;
      if (!inside) continue;
      const v = (s.pixels[y * s.cols + x] as number) * s.slope + s.intercept;
      n++;
      sum += v;
      sumSq += v * v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (n === 0) return lines;

  const mean = sum / n;
  const variance = n > 1 ? Math.max(0, (sumSq - n * mean * mean) / (n - 1)) : 0;
  const unit = modality === "CT" ? " HU" : "";
  lines.push(
    `Mean ${num(mean, 1)}${unit}  SD ${num(Math.sqrt(variance), 1)}`,
    `Min ${num(min, 0)}  Max ${num(max, 0)}  (${n} px)`,
  );
  return lines;
}

// ---------- Aneurysm template ----------

export interface AneurysmPoints {
  neckA: Pt;
  neckB: Pt;
  dome: Pt; // the point of the dome that is farthest from the neck
  domeWidth?: [Pt, Pt]; // the widest part of the dome, measured across it
}

const toMm = (a: Pt, b: Pt, sp: Spacing | null): number => {
  const kx = sp ? sp.col : 1;
  const ky = sp ? sp.row : 1;
  return Math.hypot((b.x - a.x) * kx, (b.y - a.y) * ky);
};

// Distance from `p` to the line through `a` and `b`, measured the same way as lengths
function distanceToLine(p: Pt, a: Pt, b: Pt, sp: Spacing | null): number {
  const kx = sp ? sp.col : 1;
  const ky = sp ? sp.row : 1;
  const ax = a.x * kx;
  const ay = a.y * ky;
  const dx = b.x * kx - ax;
  const dy = b.y * ky - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(p.x * kx - ax, p.y * ky - ay);
  return Math.abs(dx * (p.y * ky - ay) - dy * (p.x * kx - ax)) / len;
}

export function aneurysmLines(pts: AneurysmPoints, sp: Spacing | null): string[] {
  const unit = sp ? "mm" : "px";
  const mark = sp?.approx ? "≈ " : "";
  const fmt = (v: number): string => `${mark}${num(v, v >= 10 ? 1 : 2)} ${unit}`;

  const neck = toMm(pts.neckA, pts.neckB, sp);
  const height = distanceToLine(pts.dome, pts.neckA, pts.neckB, sp);
  const lines = [`Neck ${fmt(neck)}`, `Dome height ${fmt(height)}`];
  if (neck > 1e-9) lines.push(`Aspect ratio ${num(height / neck, 2)}`);

  if (pts.domeWidth) {
    const width = toMm(pts.domeWidth[0], pts.domeWidth[1], sp);
    lines.push(`Dome width ${fmt(width)}`);
    if (neck > 1e-9) lines.push(`Dome/neck ${num(width / neck, 2)}`);
  }
  lines.push("(one plane)");
  return lines;
}