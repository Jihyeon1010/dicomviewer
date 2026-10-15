import { ACTIONS, type Bindings } from "./keymap";
import { DEFAULT_LAYOUT, parseLayout, type Layout } from "./layout";

export type OverlayMode = "full" | "minimal" | "off";
export type SliderPosition = "bottom" | "right";
export const SLIDER_POSITIONS: SliderPosition[] = ["bottom", "right"];
export const OVERLAY_MODES: OverlayMode[] = ["full", "minimal", "off"];

export interface Settings {
  version: 1;
  overlay: OverlayMode;
  anonymize: boolean;
  markers: boolean;
  layout: Layout;
  sliderPos: SliderPosition;
  syncScroll: boolean;
  syncWindow: boolean;
  keymap: Bindings; // overrides only: actions whose keys differ from the defaults
}

const STORAGE_KEY = "settings";

function defaults(): Settings {
  return {
    version: 1,
    overlay: "full",
    anonymize: false,
    markers: true,
    layout: { ...DEFAULT_LAYOUT },
    sliderPos: "bottom",
    syncScroll: true,
    syncWindow: false,
    keymap: {},
  };
}

function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage can be unavailable; fall back to defaults
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Never trusts stored data: every field is validated, unknown fields are dropped
function sanitize(p: unknown, base: Settings): Settings {
  if (!isRecord(p)) return base;
  const out: Settings = { ...base };

  const mode = OVERLAY_MODES.find((m) => m === p["overlay"]);
  if (mode) out.overlay = mode;
  const layout = parseLayout(p["layout"]);
  if (layout) out.layout = layout;
  const pos = SLIDER_POSITIONS.find((s) => s === p["sliderPos"]);
  if (pos) out.sliderPos = pos;
  if (typeof p["anonymize"] === "boolean") out.anonymize = p["anonymize"];
  if (typeof p["markers"] === "boolean") out.markers = p["markers"];
  if (typeof p["syncScroll"] === "boolean") out.syncScroll = p["syncScroll"];
  if (typeof p["syncWindow"] === "boolean") out.syncWindow = p["syncWindow"];

  const km = p["keymap"];
  if (isRecord(km)) {
    const clean: Bindings = {};
    for (const a of ACTIONS) {
      const v = km[a.id];
      if (Array.isArray(v) && v.every((x): x is string => typeof x === "string")) {
        clean[a.id] = [...new Set(v)];
      }
    }
    out.keymap = clean;
  }
  return out;
}

// One-time import of the separate keys used before settings were consolidated
function migrateLegacy(base: Settings): Settings {
  const overlay = readItem("overlay");
  const mode = OVERLAY_MODES.find((m) => m === overlay);
  const anonymize = readItem("anonymize");
  const markers = readItem("markers");
  return {
    ...base,
    overlay: mode ?? base.overlay,
    anonymize: anonymize === null ? base.anonymize : anonymize === "1",
    markers: markers === null ? base.markers : markers !== "0",
  };
}

export function loadSettings(): Settings {
  const base = defaults();
  const raw = readItem(STORAGE_KEY);
  if (raw === null) return migrateLegacy(base);
  try {
    return sanitize(JSON.parse(raw), base);
  } catch {
    return base;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // ignore: settings are a convenience only
  }
}