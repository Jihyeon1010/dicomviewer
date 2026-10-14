export interface Layout {
  cols: number;
  rows: number;
}

export const MAX_COLS = 4;
export const MAX_ROWS = 3;
export const DEFAULT_LAYOUT: Layout = { cols: 1, rows: 1 };

// Layouts that get a keyboard shortcut and a menu entry; any other combination
// up to MAX_COLS x MAX_ROWS is available from the toolbar picker.
export const LAYOUT_PRESETS: Layout[] = [
  { cols: 1, rows: 1 },
  { cols: 2, rows: 1 },
  { cols: 1, rows: 2 },
  { cols: 2, rows: 2 },
  { cols: 3, rows: 2 },
  { cols: 3, rows: 3 },
  { cols: 4, rows: 3 },
];

function inRange(cols: number, rows: number): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= 1 &&
    cols <= MAX_COLS &&
    rows >= 1 &&
    rows <= MAX_ROWS
  );
}

// Accepts the { cols, rows } shape and the older "2x1" strings; null when invalid
export function parseLayout(v: unknown): Layout | null {
  if (typeof v === "string") {
    const m = /^(\d)x(\d)$/.exec(v);
    if (!m) return null;
    const cols = Number(m[1]);
    const rows = Number(m[2]);
    return inRange(cols, rows) ? { cols, rows } : null;
  }
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const cols = o["cols"];
    const rows = o["rows"];
    if (typeof cols === "number" && typeof rows === "number" && inRange(cols, rows)) {
      return { cols, rows };
    }
  }
  return null;
}