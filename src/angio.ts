import { num } from "./format";
import { seriesSource, sliceCache, type CachedSlice, type SliceSource } from "./slice-cache";
import type { SliceData } from "./types";

export type SubtractMode = "linear" | "log";
export type ProjectionMode = "off" | "min" | "max" | "mean";
export const PROJECTION_MODES: ProjectionMode[] = ["off", "min", "max", "mean"];

export interface MaskSpec {
  from: number; // first frame of the mask, zero-based
  to: number;   // last frame, inclusive
}

const MAX_MASK_FRAMES = 20;
const LOG_SCALE = 1000; // stored units per unit of ln(intensity) in log mode
const MAX_STORED = 32767;
const PARALLEL = 4; // frames requested at the same time

type Pixels = SliceData["pixels"];

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

// ln(v + 1) for every raw value of 8 and 16 bit data, filled on first use
const logTables = new Map<number, Float32Array>();

function logTable(size: number): Float32Array {
  let t = logTables.get(size);
  if (!t) {
    t = new Float32Array(size);
    for (let i = 0; i < size; i++) t[i] = Math.log(i + 1);
    logTables.set(size, t);
  }
  return t;
}

const logIndex = (v: number): number => (v < 0 ? 0 : v > 65535 ? 65535 : v);

// ---------- Mask and subtraction ----------

interface MaskData {
  rows: number;
  cols: number;
  linear: Float32Array; // mean of the mask frames, in raw values
  log: Float32Array;    // ln(mean + 1)
}

async function buildMask(uid: string, spec: MaskSpec): Promise<MaskData> {
  const src = seriesSource(uid);
  const wanted: number[] = [];
  for (let i = spec.from; i <= spec.to; i++) wanted.push(i);
  const frames = await Promise.all(wanted.map((i) => sliceCache.get(src, i)));

  const first = frames[0]?.slice;
  if (!first) throw new Error("The mask has no frames");
  if (first.samples !== 1) throw new Error("Subtraction needs grayscale images");

  const n = first.rows * first.cols;
  const linear = new Float32Array(n);
  for (const f of frames) {
    const s = f.slice;
    if (s.rows !== first.rows || s.cols !== first.cols || s.samples !== 1) {
      throw new Error("The mask frames differ in size");
    }
    for (let i = 0; i < n; i++) linear[i] = (linear[i] as number) + (s.pixels[i] as number);
  }
  const k = 1 / frames.length;
  const log = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const m = (linear[i] as number) * k;
    linear[i] = m;
    log[i] = Math.log(Math.max(m, 0) + 1);
  }
  return { rows: first.rows, cols: first.cols, linear, log };
}

interface Subtracted {
  data: Int16Array;
  slope: number; // real value = stored * slope
}

/**
 * frame - mask, so that contrast (which darkens the frame) comes out negative and is shown
 * dark. The mask is moved by (dx, dy) pixels first. MONOCHROME1 data counts the other way
 * round and is flipped, so the result always reads "brighter is more".
 */
function subtractFrame(
  f: SliceData,
  m: MaskData,
  mode: SubtractMode,
  dx: number,
  dy: number,
): Subtracted {
  if (f.samples !== 1) throw new Error("Subtraction needs grayscale images");
  if (f.rows !== m.rows || f.cols !== m.cols) {
    throw new Error("The frame and the mask differ in size");
  }
  const { rows, cols } = f;
  const px = f.pixels;
  const out = new Int16Array(rows * cols);
  const log = mode === "log";
  const table = logTable(px instanceof Uint8Array ? 256 : 65536);
  // 16-bit differences reach +-65535, so they are halved to fit into a signed 16-bit value
  const gain = px instanceof Uint8Array ? 1 : 0.5;
  const k = (f.monochrome1 ? -1 : 1) * (log ? LOG_SCALE : gain);

  for (let y = 0; y < rows; y++) {
    const my = y - dy;
    if (my < 0 || my >= rows) continue; // no mask here: the difference stays 0
    for (let x = 0; x < cols; x++) {
      const mx = x - dx;
      if (mx < 0 || mx >= cols) continue;
      const i = y * cols + x;
      const j = my * cols + mx;
      const v = px[i] as number;
      const d = log
        ? (table[logIndex(v)] as number) - (m.log[j] as number)
        : v - (m.linear[j] as number);
      const s = Math.round(k * d);
      out[i] = s > MAX_STORED ? MAX_STORED : s < -MAX_STORED ? -MAX_STORED : s;
    }
  }
  return { data: out, slope: log ? 1 / LOG_SCALE : (f.slope || 1) / gain };
}

// 99th percentile of the absolute values, from a sample of the pixels
function percentile99(data: Int16Array): number {
  const step = Math.max(1, Math.floor(data.length / 20000));
  const vals: number[] = [];
  for (let i = 0; i < data.length; i += step) vals.push(Math.abs(data[i] as number));
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.99)] ?? 0;
}

// ---------- State of one viewport ----------

/**
 * Digital subtraction and projection over time for the frames of one series. It hands out
 * image sources; the viewport shows them in place of the plain frames.
 */
export class Angio {
  readonly uid: string;
  readonly count: number;

  dsa = false;
  mode: SubtractMode = "linear";
  modeChosen = false; // the user picked a mode, so it is no longer chosen from the file
  mask: MaskSpec = { from: 0, to: 0 };
  dx = 0;
  dy = 0;
  proj: ProjectionMode = "off";

  private win = { wl: 0, ww: 100 };
  private winKey = "";
  private masks = new Map<string, Promise<MaskData>>();

  constructor(uid: string, count: number) {
    this.uid = uid;
    this.count = count;
  }

  get active(): boolean {
    return this.dsa || this.proj !== "off";
  }

  clampMask(): void {
    const last = Math.max(0, this.count - 1);
    const from = clamp(this.mask.from, 0, last);
    const to = clamp(this.mask.to, from, Math.min(last, from + MAX_MASK_FRAMES - 1));
    this.mask = { from, to };
  }

  /** What to show instead of the plain frames, or null when nothing is derived. */
  source(): SliceSource | null {
    if (this.proj !== "off") return this.projectionSource(this.baseSource());
    return this.dsa ? this.dsaSource() : null;
  }

  /** Builds the mask and the default window. Call before showing the subtraction. */
  async prepare(): Promise<void> {
    if (!this.dsa) return;
    this.clampMask();
    const mask = await this.maskFor(this.mask);
    const key = `${this.mask.from}-${this.mask.to}:${this.mode}`;
    if (key === this.winKey) return; // shifting the mask does not change the window

    // The window comes from a few frames spread over the series
    const src = seriesSource(this.uid);
    const picks = new Set<number>();
    for (let k = 0; k <= 4; k++) picks.add(Math.round((k * (this.count - 1)) / 4));
    let p99 = 0;
    let slope = 1;
    for (const i of picks) {
      const f = (await sliceCache.get(src, i)).slice;
      const r = subtractFrame(f, mask, this.mode, 0, 0);
      p99 = Math.max(p99, percentile99(r.data));
      slope = r.slope;
    }
    const minStored = this.mode === "log" ? 100 : 16;
    this.win = { wl: 0, ww: Math.max(4 * p99, minStored) * slope };
    this.winKey = key;
  }

  private maskFor(spec: MaskSpec): Promise<MaskData> {
    const key = `${spec.from}-${spec.to}`;
    let p = this.masks.get(key);
    if (!p) {
      p = buildMask(this.uid, spec);
      this.masks.set(key, p);
      p.catch(() => this.masks.delete(key)); // a failed build must not be remembered
      while (this.masks.size > 4) {
        const oldest = this.masks.keys().next().value;
        if (oldest === undefined) break;
        this.masks.delete(oldest);
      }
    }
    return p;
  }

  private baseSource(): SliceSource {
    return this.dsa ? this.dsaSource() : seriesSource(this.uid);
  }

  private dsaSource(): SliceSource {
    const uid = this.uid;
    const mode = this.mode;
    const { dx, dy } = this;
    const spec = { ...this.mask };
    const base = seriesSource(uid);
    return {
      id: `dsa:${uid}:${spec.from}-${spec.to}:${mode}:${dx},${dy}`,
      load: async (index): Promise<CachedSlice> => {
        const [frame, mask] = await Promise.all([sliceCache.get(base, index), this.maskFor(spec)]);
        const r = subtractFrame(frame.slice, mask, mode, dx, dy);
        const slice: SliceData = {
          ...frame.slice,
          bitsAllocated: 16,
          signed: true,
          slope: r.slope,
          intercept: 0,
          defaultWl: this.win.wl,
          defaultWw: this.win.ww,
          monochrome1: false,
          samples: 1,
          pixels: r.data,
        };
        const meta = frame.meta
          ? {
              ...frame.meta,
              series_description: [frame.meta.series_description, "DSA"].filter(Boolean).join(" · "),
            }
          : null;
        return { slice, meta };
      },
    };
  }

  // One image that combines all frames of `base`
  private projectionSource(base: SliceSource): SliceSource {
    const mode = this.proj;
    const count = this.count;
    return {
      id: `tproj:${base.id}:${mode}`,
      load: async (): Promise<CachedSlice> => {
        let first: CachedSlice | null = null;
        let acc: Float32Array | null = null;
        let op: "min" | "max" | "mean" = "max";

        for (let b = 0; b < count; b += PARALLEL) {
          const batch: Promise<CachedSlice>[] = [];
          for (let i = b; i < Math.min(count, b + PARALLEL); i++) {
            batch.push(sliceCache.get(base, i));
          }
          for (const c of await Promise.all(batch)) {
            const s = c.slice;
            if (!first || !acc) {
              if (s.samples !== 1) throw new Error("Projection needs grayscale images");
              first = c;
              acc = new Float32Array(s.pixels);
              // "Min" and "Max" refer to what is shown, and MONOCHROME1 shows high values dark
              op = mode === "mean" ? "mean" : (mode === "min") !== s.monochrome1 ? "min" : "max";
              continue;
            }
            const f = first.slice;
            if (s.rows !== f.rows || s.cols !== f.cols || s.samples !== 1) {
              throw new Error("The frames differ in size");
            }
            const px = s.pixels;
            for (let i = 0; i < acc.length; i++) {
              const v = px[i] as number;
              const a = acc[i] as number;
              if (op === "mean") acc[i] = a + v;
              else if (op === "min") {
                if (v < a) acc[i] = v;
              } else if (v > a) acc[i] = v;
            }
          }
        }
        if (!first || !acc) throw new Error("There are no frames to project");

        const px = first.slice.pixels;
        const out: Pixels =
          px instanceof Uint8Array
            ? new Uint8Array(acc.length)
            : px instanceof Int16Array
              ? new Int16Array(acc.length)
              : new Uint16Array(acc.length);
        for (let i = 0; i < acc.length; i++) {
          const a = acc[i] as number;
          out[i] = op === "mean" ? Math.round(a / count) : a;
        }
        const label =
          mode === "min" ? "Min projection" : mode === "max" ? "Max projection" : "Mean projection";
        const meta = first.meta
          ? {
              ...first.meta,
              series_description: [first.meta.series_description, label].filter(Boolean).join(" · "),
            }
          : null;
        return { slice: { ...first.slice, pixels: out }, meta };
      },
    };
  }
}

// ---------- Display ----------

/** "RAO 30° · CRAN 2°"; the primary angle is positive towards LAO, the secondary towards cranial. */
export function positionerText(primary: number | null, secondary: number | null): string {
  const p = primary !== null && Number.isFinite(primary) ? primary : null;
  const s = secondary !== null && Number.isFinite(secondary) ? secondary : null;
  if (p === null && s === null) return "";
  if (p !== null && s !== null && Math.abs(p) < 1.5 && Math.abs(s) < 1.5) return "AP";
  const parts: string[] = [];
  if (p !== null) parts.push(`${p >= 0 ? "LAO" : "RAO"} ${num(Math.abs(p), 0)}°`);
  if (s !== null) parts.push(`${s >= 0 ? "CRAN" : "CAUD"} ${num(Math.abs(s), 0)}°`);
  return parts.join(" · ");
}