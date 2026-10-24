import { ACTIONS, type Bindings } from "./keymap";
import { DEFAULT_LAYOUT, parseLayout, type Layout } from "./layout";
import { ORIENT_MODES, type OrientMode } from "./orient-auto";

export type OverlayMode = "full" | "minimal" | "off";
export type SliderPosition = "bottom" | "right";
export const SLIDER_POSITIONS: SliderPosition[] = ["bottom", "right"];
export const OVERLAY_MODES: OverlayMode[] = ["full", "minimal", "off"];

/** How far the wheel or the scroll tool has to move for one image: slow needs the most. */
export type Sensitivity = "slow" | "normal" | "fast";
export const SENSITIVITIES: Sensitivity[] = ["slow", "normal", "fast"];
/** Wheel units (pixels of delta) per image */
export const WHEEL_PX: Record<Sensitivity, number> = { slow: 80, normal: 40, fast: 20 };
/** Pixels of mouse movement per image with the scroll tool */
export const SCROLL_PX: Record<Sensitivity, number> = { slow: 16, normal: 8, fast: 4 };

/** What the graph of a voxel through the volumes of a 4D file shows */
export type TimeCourseMode = "raw" | "percent";
export const TIME_COURSE_MODES: TimeCourseMode[] = ["raw", "percent"];

export interface Settings {
  version: 1;
  overlay: OverlayMode;
  anonymize: boolean;
  markers: boolean;
  layout: Layout;
  sliderPos: SliderPosition;
  orientMode: OrientMode;
  syncScroll: boolean;
  syncWindow: boolean;
  smooth: boolean; // images are drawn smoothed when enlarged, not as sharp pixels
  wheelReverse: boolean;
  wheelSensitivity: Sensitivity;
  scrollSensitivity: Sensitivity;
  timeCourseMode: TimeCourseMode;
  pythonPath: string; // "" lets the app look for a Python
  exportDir: string; // the folder where the save windows open; "" leaves it to the system
  keymap: Bindings; // overrides only: actions whose keys differ from the defaults
}

const STORAGE_KEY = "settings";

export function defaultSettings(): Settings {
  return {
    version: 1,
    overlay: "full",
    anonymize: false,
    markers: true,
    layout: { ...DEFAULT_LAYOUT },
    sliderPos: "bottom",
    orientMode: "standard",
    syncScroll: true,
    syncWindow: false,
    smooth: false,
    wheelReverse: false,
    wheelSensitivity: "normal",
    scrollSensitivity: "normal",
    timeCourseMode: "raw",
    pythonPath: "",
    exportDir: "",
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
  const orient = ORIENT_MODES.find((o) => o === p["orientMode"]);
  if (orient) out.orientMode = orient;
  if (typeof p["anonymize"] === "boolean") out.anonymize = p["anonymize"];
  if (typeof p["markers"] === "boolean") out.markers = p["markers"];
  if (typeof p["syncScroll"] === "boolean") out.syncScroll = p["syncScroll"];
  if (typeof p["syncWindow"] === "boolean") out.syncWindow = p["syncWindow"];
  if (typeof p["smooth"] === "boolean") out.smooth = p["smooth"];
  if (typeof p["wheelReverse"] === "boolean") out.wheelReverse = p["wheelReverse"];
  const wheel = SENSITIVITIES.find((v) => v === p["wheelSensitivity"]);
  if (wheel) out.wheelSensitivity = wheel;
  const scroll = SENSITIVITIES.find((v) => v === p["scrollSensitivity"]);
  if (scroll) out.scrollSensitivity = scroll;
  const course = TIME_COURSE_MODES.find((v) => v === p["timeCourseMode"]);
  if (course) out.timeCourseMode = course;
  if (typeof p["exportDir"] === "string") out.exportDir = p["exportDir"].trim().slice(0, 1024);
  if (typeof p["pythonPath"] === "string") out.pythonPath = p["pythonPath"].trim().slice(0, 1024);

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
  const base = defaultSettings();
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