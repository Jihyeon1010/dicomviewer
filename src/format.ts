export type Maybe = string | false | null | undefined;

export function compact(items: Maybe[]): string[] {
  return items.filter((x): x is string => typeof x === "string" && x !== "");
}

// DICOM person names use '^' as the component separator
export const cleanName = (s: string): string => s.replace(/\^+/g, " ").trim();

export function fmtDate(d: string): string {
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d;
}

export function fmtTime(t: string): string {
  const m = /^(\d{2})(\d{2})(\d{2})/.exec(t);
  return m ? `${m[1]}:${m[2]}:${m[3]}` : t;
}

// "034Y" -> "34Y"
export const fmtAge = (a: string): string => a.replace(/^0+(?=\d)/, "");

// Rounds to `digits` decimals and drops trailing zeros
export const num = (v: number, digits = 2): string => String(+v.toFixed(digits));