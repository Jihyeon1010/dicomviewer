import type { EdgeLabels } from "./guides";

export interface Pt {
  x: number;
  y: number;
}

export interface Size {
  cols: number;
  rows: number;
}

export interface ViewParams {
  zoom: number;
  panX: number;
  panY: number;
}

// Orientation is applied on screen: rotate first, then mirror. "Flip horizontal"
// therefore always mirrors left-right as seen, whatever the rotation is.
export interface Orient {
  rot: number;    // clockwise quarter turns, 0..3
  flipH: boolean; // mirror left-right
  flipV: boolean; // mirror top-bottom
}

export const NO_ORIENT: Orient = { rot: 0, flipH: false, flipV: false };

// Exact values for quarter turns (y points down, so +90 degrees is clockwise on screen)
const COS = [1, 0, -1, 0];
const SIN = [0, 1, 0, -1];

const quarter = (o: Orient): number => ((o.rot % 4) + 4) % 4;

// Orientation matrix M = F * R as [[a, b], [c, d]]. It is orthogonal, so M^-1 = M^T.
export function matrix(o: Orient): { a: number; b: number; c: number; d: number } {
  const k = quarter(o);
  const cos = COS[k] as number;
  const sin = SIN[k] as number;
  const sx = o.flipH ? -1 : 1;
  const sy = o.flipV ? -1 : 1;
  return { a: sx * cos, b: -sx * sin, c: sy * sin, d: sy * cos };
}

// Screen position = pan + zoom * (center + M * (p - center)); the image center stays fixed
export function imageToScreen(p: Pt, size: Size, v: ViewParams, o: Orient): Pt {
  const m = matrix(o);
  const cx = size.cols / 2;
  const cy = size.rows / 2;
  const qx = p.x - cx;
  const qy = p.y - cy;
  return {
    x: v.panX + v.zoom * (cx + m.a * qx + m.b * qy),
    y: v.panY + v.zoom * (cy + m.c * qx + m.d * qy),
  };
}

export function screenToImage(s: Pt, size: Size, v: ViewParams, o: Orient): Pt {
  const m = matrix(o);
  const cx = size.cols / 2;
  const cy = size.rows / 2;
  const qx = (s.x - v.panX) / v.zoom - cx;
  const qy = (s.y - v.panY) / v.zoom - cy;
  // M^T = [[a, c], [b, d]]
  return { x: cx + m.a * qx + m.c * qy, y: cy + m.b * qx + m.d * qy };
}

/**
 * The pan that keeps the image point shown at `anchor` (a screen position) where it is when
 * the orientation changes from `from` to `to`. Without it a turn or mirror happens about the
 * center of the image, which carries a zoomed or panned view away from what is being looked at.
 */
export function panForOrient(
  size: Size,
  v: ViewParams,
  from: Orient,
  to: Orient,
  anchor: Pt,
): { panX: number; panY: number } {
  const p = screenToImage(anchor, size, v, from);
  const s = imageToScreen(p, size, v, to);
  return { panX: v.panX + anchor.x - s.x, panY: v.panY + anchor.y - s.y };
}

// The same transform as a CSS value for the canvas (transform-origin must be 0 0)
export function cssTransform(size: Size, v: ViewParams, o: Orient): string {
  const cx = size.cols / 2;
  const cy = size.rows / 2;
  return (
    `translate(${v.panX}px, ${v.panY}px) scale(${v.zoom}) translate(${cx}px, ${cy}px) ` +
    `scale(${o.flipH ? -1 : 1}, ${o.flipV ? -1 : 1}) rotate(${quarter(o) * 90}deg) ` +
    `translate(${-cx}px, ${-cy}px)`
  );
}

/** Labels of the four screen edges, given the labels of the stored image's edges. */
export function orientedLabels(l: EdgeLabels, o: Orient): EdgeLabels {
  const m = matrix(o);
  // Which stored edge faces the screen direction (dx, dy)?  v = M^T * d
  const pick = (dx: number, dy: number): string => {
    const vx = m.a * dx + m.c * dy;
    const vy = m.b * dx + m.d * dy;
    if (Math.abs(vx) > Math.abs(vy)) return vx > 0 ? l.right : l.left;
    return vy > 0 ? l.bottom : l.top;
  };
  return { right: pick(1, 0), left: pick(-1, 0), top: pick(0, -1), bottom: pick(0, 1) };
}

export function orientText(o: Orient): string {
  const parts: string[] = [];
  if (quarter(o) !== 0) parts.push(`Rot ${quarter(o) * 90}°`);
  if (o.flipH) parts.push("Flip H");
  if (o.flipV) parts.push("Flip V");
  return parts.join(" · ");
}