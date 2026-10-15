import { getSlice, getSliceMeta } from "./api";
import type { SliceData, SliceMeta } from "./types";

export interface CachedSlice {
  slice: SliceData;
  meta: SliceMeta | null;
}

/** Where a viewport gets its images from: the images of a series, or a reformatted view. */
export interface SliceSource {
  /** Identifies the images in the cache; sources with the same id must give the same images. */
  id: string;
  load(index: number): Promise<CachedSlice>;
  /** Maps indices that give the same image to one index (a projection through the whole volume). */
  canonical?(index: number): number;
}

async function fetchSeriesSlice(uid: string, index: number): Promise<CachedSlice> {
  // Metadata is optional: a failure there must not block the image
  const [slice, meta] = await Promise.all([
    getSlice(uid, index),
    getSliceMeta(uid, index).catch(() => null),
  ]);
  return { slice, meta };
}

const seriesSources = new Map<string, SliceSource>();

/** The plain images of a series. */
export function seriesSource(uid: string): SliceSource {
  let s = seriesSources.get(uid);
  if (!s) {
    s = { id: uid, load: (index) => fetchSeriesSlice(uid, index) };
    seriesSources.set(uid, s);
  }
  return s;
}

interface Entry {
  promise: Promise<CachedSlice>;
  bytes: number; // 0 until the request has finished
}

interface Plan {
  source: SliceSource;
  indices: number[]; // images still to fetch, most useful first
}

// Upper bound for the pixel data kept in the webview. A 512 x 512 16-bit CT image is 0.5 MB.
const MAX_BYTES = 512 * 1024 * 1024;
// Background requests running at the same time
const MAX_PARALLEL = 3;

const keyOf = (id: string, index: number): string => `${id}#${index}`;

const canonicalOf = (source: SliceSource, index: number): number =>
  source.canonical ? source.canonical(index) : index;

/**
 * Images and their metadata, shared by all viewports. Requests are stored as promises,
 * so a prefetch and a real request for the same image share one round trip.
 */
class SliceCache {
  // Iteration order is least recently used first
  private entries = new Map<string, Entry>();
  private total = 0;
  private generation = 0; // bumped by clear(); late results of older requests are ignored
  private plans = new Map<object, Plan>();
  private inFlight = 0;

  /** The image, from the cache when it is there, otherwise fetched now. */
  get(source: SliceSource, index: number): Promise<CachedSlice> {
    const canon = canonicalOf(source, index);
    const key = keyOf(source.id, canon);
    const hit = this.entries.get(key);
    if (hit) {
      // Mark as most recently used
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit.promise;
    }
    return this.start(source, canon, key).promise;
  }

  /** Replaces what `owner` wants prefetched. Cheap to call after every image change. */
  plan(owner: object, source: SliceSource, indices: number[]): void {
    this.plans.set(owner, { source, indices: [...indices] });
    this.pump();
  }

  cancel(owner: object): void {
    this.plans.delete(owner);
  }

  /** Forgets everything; call when the loaded files change, since indices then mean other images. */
  clear(): void {
    this.generation++;
    this.entries.clear();
    this.total = 0;
    this.plans.clear();
  }

  private start(source: SliceSource, index: number, key: string): Entry {
    const gen = this.generation;
    const promise = source.load(index);
    const entry: Entry = { promise, bytes: 0 };
    this.entries.set(key, entry);

    promise.then(
      (value) => {
        if (gen !== this.generation) return; // cleared in the meantime
        entry.bytes = value.slice.pixels.buffer.byteLength;
        this.total += entry.bytes;
        this.evict();
      },
      () => {
        // A failed request must not be remembered, so that a later try can succeed
        if (gen === this.generation && this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
      },
    );
    return entry;
  }

  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.total <= MAX_BYTES) break;
      if (entry.bytes === 0) continue; // still loading, nothing to free yet
      this.entries.delete(key);
      this.total -= entry.bytes;
    }
  }

  private pump(): void {
    while (this.inFlight < MAX_PARALLEL) {
      const next = this.nextWanted();
      if (!next) return;
      this.inFlight++;
      const entry = this.start(next.source, next.index, keyOf(next.source.id, next.index));
      const done = (): void => {
        this.inFlight--;
        this.pump();
      };
      entry.promise.then(done, done);
    }
  }

  private nextWanted(): { source: SliceSource; index: number } | null {
    for (const [owner, plan] of this.plans) {
      for (let index = plan.indices.shift(); index !== undefined; index = plan.indices.shift()) {
        const canon = canonicalOf(plan.source, index);
        if (!this.entries.has(keyOf(plan.source.id, canon))) {
          return { source: plan.source, index: canon };
        }
      }
      this.plans.delete(owner); // nothing left to fetch for this owner
    }
    return null;
  }
}

export const sliceCache = new SliceCache();