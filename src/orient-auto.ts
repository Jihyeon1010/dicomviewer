import type { EdgeLabels } from "./guides";
import { NO_ORIENT, orientedLabels, type Orient } from "./transform2d";
import type { Plane } from "./types";

export type OrientMode = "standard" | "stored";
export const ORIENT_MODES: OrientMode[] = ["standard", "stored"];

// What each plane shows on its edges in the radiological convention: the axial view has the
// anterior side on top and the patient's right on the left; the coronal view the superior
// side on top and the right on the left; the sagittal view the superior side on top and
// the anterior side on the left.
const TARGET: Record<Plane, { top: string; left: string }> = {
  axial: { top: "A", left: "R" },
  coronal: { top: "S", left: "R" },
  sagittal: { top: "S", left: "A" },
};

// Quarter turns and mirroring cover all eight ways to place a rectangular image
const CANDIDATES: Orient[] = [];
for (let rot = 0; rot < 4; rot++) {
  for (const flipH of [false, true]) {
    CANDIDATES.push({ rot, flipH, flipV: false });
  }
}

// An edge label can have two letters for an oblique plane ("AR"); only the main one counts
const main = (s: string): string => s.charAt(0);

/**
 * The rotation and mirroring that put the image into the radiological convention for its
 * plane, or the identity when it already is in that convention or when no orientation
 * information exists. `labels` are the labels of the edges of the image as stored.
 */
export function autoOrient(labels: EdgeLabels | null, plane: Plane): Orient {
  if (!labels) return { ...NO_ORIENT };
  const want = TARGET[plane];

  let best: Orient | null = null;
  let bestScore = -1;
  for (const o of CANDIDATES) {
    const l = orientedLabels(labels, o);
    const score = (main(l.top) === want.top ? 2 : 0) + (main(l.left) === want.left ? 1 : 0);
    // The first of the candidates wins ties, and they start at the identity
    if (score > bestScore) {
      best = o;
      bestScore = score;
    }
  }
  // Both edges must match; otherwise the data is too oblique to correct reliably
  return best && bestScore === 3 ? { ...best } : { ...NO_ORIENT };
}