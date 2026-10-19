import { LAYOUT_PRESETS } from "./layout";

// Key combos are strings: optional "Ctrl+", "Alt+", "Shift+" prefixes (in that order)
// followed by a KeyboardEvent.code, e.g. "ArrowDown" or "Shift+Equal".
// Using `code` (physical key) keeps shortcuts working with any input language.

export type Bindings = Record<string, string[]>; // action id -> key combos

export interface ActionDef {
  id: string;
  label: string;
  group: string;
  defaults: string[];
  repeat?: boolean; // allow auto-repeat while the key is held
}

// Number of window preset actions (preset.1 ... preset.N); main.ts must define as many presets
export const PRESET_COUNT = 6;

// Actions of one group must stay together: the settings dialog prints a heading
// whenever the group changes from one entry to the next.
export const ACTIONS: ActionDef[] = [
  { id: "slice.prev", label: "Previous image", group: "Navigation", defaults: ["ArrowUp", "ArrowLeft"], repeat: true },
  { id: "slice.next", label: "Next image", group: "Navigation", defaults: ["ArrowDown", "ArrowRight"], repeat: true },
  { id: "slice.back10", label: "Back 10 images", group: "Navigation", defaults: ["PageUp"], repeat: true },
  { id: "slice.fwd10", label: "Forward 10 images", group: "Navigation", defaults: ["PageDown"], repeat: true },
  { id: "slice.first", label: "First image", group: "Navigation", defaults: ["Home"] },
  { id: "slice.last", label: "Last image", group: "Navigation", defaults: ["End"] },

  { id: "view.zoomIn", label: "Zoom in", group: "View", defaults: ["Equal", "Shift+Equal", "NumpadAdd"], repeat: true },
  { id: "view.zoomOut", label: "Zoom out", group: "View", defaults: ["Minus", "NumpadSubtract"], repeat: true },
  { id: "view.fit", label: "Fit to window", group: "View", defaults: ["Digit0", "Numpad0"] },

  { id: "view.rotateCW", label: "Rotate clockwise", group: "Orientation", defaults: ["KeyE"] },
  { id: "view.rotateCCW", label: "Rotate counterclockwise", group: "Orientation", defaults: ["Shift+KeyE"] },
  { id: "view.flipH", label: "Flip horizontally", group: "Orientation", defaults: ["KeyH"] },
  { id: "view.flipV", label: "Flip vertically", group: "Orientation", defaults: ["Shift+KeyH"] },
  { id: "view.resetOrientation", label: "Reset orientation", group: "Orientation", defaults: ["Shift+KeyR"] },
    { id: "view.orientMode", label: "Orientation: standard / as stored", group: "Orientation", defaults: ["Shift+KeyO"] },

  { id: "tool.window", label: "Window / Level tool", group: "Tools", defaults: ["KeyW"] },
  { id: "tool.pan", label: "Pan tool", group: "Tools", defaults: ["KeyP"] },
  { id: "tool.zoom", label: "Zoom tool", group: "Tools", defaults: ["KeyZ"] },
  { id: "tool.scroll", label: "Scroll tool", group: "Tools", defaults: ["KeyS"] },
  { id: "tool.length", label: "Length measurement", group: "Tools", defaults: ["KeyD"] },
  { id: "tool.angle", label: "Angle measurement", group: "Tools", defaults: ["KeyG"] },
  { id: "tool.ellipse", label: "Elliptical ROI", group: "Tools", defaults: ["KeyC"] },
  { id: "tool.rect", label: "Rectangular ROI", group: "Tools", defaults: ["KeyX"] },
  { id: "tool.aneurysm", label: "Aneurysm measurement", group: "Tools", defaults: ["KeyN"] },
  { id: "tool.calibrate", label: "Calibrate length", group: "Tools", defaults: ["KeyJ"] },
  { id: "tool.cross", label: "Crosshair tool (MPR)", group: "Tools", defaults: ["KeyK"] },
  { id: "tool.rotate", label: "Rotate tool (MPR)", group: "Tools", defaults: ["KeyQ"] },

  { id: "measure.undo", label: "Delete last measurement", group: "Measurements", defaults: ["Backspace", "Delete"] },
  { id: "measure.clear", label: "Clear measurements on this image", group: "Measurements", defaults: ["Shift+Backspace", "Shift+Delete"] },
  { id: "calibration.clear", label: "Remove calibration", group: "Measurements", defaults: ["Shift+KeyJ"] },

  { id: "view.invert", label: "Invert image", group: "Window", defaults: ["KeyI"] },
  { id: "view.resetWindow", label: "Reset window", group: "Window", defaults: ["KeyR"] },
  ...Array.from({ length: PRESET_COUNT }, (_, i): ActionDef => ({
    id: `preset.${i + 1}`,
    label: `Window preset ${i + 1}`,
    group: "Window",
    defaults: [`Digit${i + 1}`],
  })),

  { id: "cine.toggle", label: "Play / pause cine", group: "Cine", defaults: ["Space"] },
  { id: "cine.faster", label: "Cine faster", group: "Cine", defaults: ["BracketRight"], repeat: true },
  { id: "cine.slower", label: "Cine slower", group: "Cine", defaults: ["BracketLeft"], repeat: true },

  { id: "cine.markIn", label: "Loop start at this frame", group: "Cine", defaults: ["Alt+KeyI"] },
  { id: "cine.markOut", label: "Loop end at this frame", group: "Cine", defaults: ["Alt+KeyO"] },
  { id: "cine.clearLoop", label: "Clear the loop", group: "Cine", defaults: ["Alt+KeyL"] },
  { id: "cine.pingpong", label: "Ping-pong playback", group: "Cine", defaults: ["Alt+KeyP"] },
  { id: "bookmark.toggle", label: "Bookmark this frame", group: "Cine", defaults: ["Alt+KeyK"] },
  { id: "bookmark.next", label: "Next bookmark", group: "Cine", defaults: ["Alt+Period"] },
  { id: "bookmark.prev", label: "Previous bookmark", group: "Cine", defaults: ["Alt+Comma"] },

  { id: "dsa.toggle", label: "Digital subtraction (DSA)", group: "Angiography", defaults: ["Shift+KeyD"] },
  { id: "tool.maskshift", label: "Mask shift tool (DSA)", group: "Angiography", defaults: ["KeyU"] },
  { id: "dsa.maskHere", label: "Use this frame as the mask", group: "Angiography", defaults: ["Shift+KeyU"] },
  { id: "dsa.shiftLeft", label: "Shift the mask left", group: "Angiography", defaults: ["Alt+ArrowLeft"], repeat: true },
  { id: "dsa.shiftRight", label: "Shift the mask right", group: "Angiography", defaults: ["Alt+ArrowRight"], repeat: true },
  { id: "dsa.shiftUp", label: "Shift the mask up", group: "Angiography", defaults: ["Alt+ArrowUp"], repeat: true },
  { id: "dsa.shiftDown", label: "Shift the mask down", group: "Angiography", defaults: ["Alt+ArrowDown"], repeat: true },
  { id: "dsa.shiftReset", label: "Reset the mask shift", group: "Angiography", defaults: ["Alt+Digit0"] },
  { id: "tproj.cycle", label: "Projection over time: off / min / max / mean", group: "Angiography", defaults: ["Shift+KeyT"] },

  { id: "ui.overlay", label: "Cycle overlay detail", group: "Interface", defaults: ["KeyO"] },
  { id: "ui.markers", label: "Toggle markers and scale bars", group: "Interface", defaults: ["KeyM"] },
  { id: "ui.anonymize", label: "Toggle anonymize", group: "Interface", defaults: ["KeyA"] },
  { id: "ui.slider", label: "Move image slider (bottom / right)", group: "Interface", defaults: ["KeyB"] },
  { id: "ui.tags", label: "DICOM tags", group: "Interface", defaults: ["KeyT"] },
  { id: "ui.settings", label: "Settings and shortcuts", group: "Interface", defaults: ["Comma", "Shift+Slash"] },

  { id: "volume.build", label: "Build 3D volume", group: "Volume", defaults: ["KeyV"] },

  { id: "mpr.toggle", label: "Multiplanar view (MPR)", group: "Volume", defaults: ["Shift+KeyM"] },
  { id: "mpr.resetRotation", label: "Reset MPR rotation", group: "Volume", defaults: ["Shift+KeyQ"] },
  { id: "mpr.mipView", label: "3D view (MPR)", group: "Volume", defaults: ["Shift+KeyV"] },
  { id: "mpr.view3dCycle", label: "3D view: MIP / MinIP / Average / Volume", group: "Volume", defaults: ["Alt+KeyV"] },

  ...LAYOUT_PRESETS.map((l, i): ActionDef => ({
    id: `layout.${l.cols}x${l.rows}`,
    label: `Layout ${l.cols} × ${l.rows}`,
    group: "Layout",
    defaults: [`Alt+Digit${i + 1}`],
  })),
  { id: "sync.scroll", label: "Toggle scroll sync", group: "Layout", defaults: ["KeyL"] },
  { id: "sync.window", label: "Toggle window sync", group: "Layout", defaults: ["Shift+KeyL"] },

  // No default keys: the File menu uses Cmd+S and Cmd+Shift+C
  { id: "export.save", label: "Save image as PNG", group: "File", defaults: [] },
  { id: "export.copy", label: "Copy image to the clipboard", group: "File", defaults: [] },
];

export const ACTION_BY_ID = new Map<string, ActionDef>(
  ACTIONS.map((a): [string, ActionDef] => [a.id, a]),
);

// ---------- Resolving and editing ----------

function copyBindings(b: Bindings): Bindings {
  const out: Bindings = {};
  for (const a of ACTIONS) out[a.id] = [...(b[a.id] ?? [])];
  return out;
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

export function isDefault(current: Bindings, actionId: string): boolean {
  return sameSet(current[actionId] ?? [], ACTION_BY_ID.get(actionId)?.defaults ?? []);
}

/**
 * Effective bindings for every action. User overrides win; default keys are
 * only used when no other action has claimed them (e.g. after a default changed).
 */
export function resolveBindings(overrides: Bindings): Bindings {
  const out: Bindings = {};
  const taken = new Set<string>();

  for (const a of ACTIONS) {
    const mine = overrides[a.id];
    if (!mine) continue;
    const list: string[] = [];
    for (const c of mine) {
      if (!taken.has(c)) {
        taken.add(c);
        list.push(c);
      }
    }
    out[a.id] = list;
  }
  for (const a of ACTIONS) {
    if (out[a.id]) continue;
    const list: string[] = [];
    for (const c of a.defaults) {
      if (!taken.has(c)) {
        taken.add(c);
        list.push(c);
      }
    }
    out[a.id] = list;
  }
  return out;
}

export function buildLookup(b: Bindings): Map<string, string> {
  const m = new Map<string, string>();
  for (const [id, combos] of Object.entries(b)) {
    for (const c of combos) if (!m.has(c)) m.set(c, id);
  }
  return m;
}

// Keeps only the actions whose keys differ from the defaults
function toOverrides(full: Bindings): Bindings {
  const o: Bindings = {};
  for (const a of ACTIONS) {
    const list = full[a.id] ?? [];
    if (!sameSet(list, a.defaults)) o[a.id] = list;
  }
  return o;
}

export interface EditResult {
  overrides: Bindings;
  moved: string[]; // labels of actions that lost a key to this edit
}

/** Adds `combo` to an action. If another action uses it, the key moves over. */
export function assign(current: Bindings, actionId: string, combo: string): EditResult {
  const full = copyBindings(current);
  const moved: string[] = [];
  for (const a of ACTIONS) {
    const list = full[a.id] ?? [];
    if (a.id === actionId) {
      if (!list.includes(combo)) list.push(combo);
      full[a.id] = list;
    } else if (list.includes(combo)) {
      full[a.id] = list.filter((c) => c !== combo);
      moved.push(a.label);
    }
  }
  return { overrides: toOverrides(full), moved };
}

export function unassign(current: Bindings, actionId: string, combo: string): Bindings {
  const full = copyBindings(current);
  full[actionId] = (full[actionId] ?? []).filter((c) => c !== combo);
  return toOverrides(full);
}

/** Restores an action's default keys, taking them back from other actions if needed. */
export function resetAction(current: Bindings, actionId: string): EditResult {
  const def = ACTION_BY_ID.get(actionId);
  if (!def) return { overrides: toOverrides(copyBindings(current)), moved: [] };

  const full = copyBindings(current);
  const moved: string[] = [];
  full[actionId] = [...def.defaults];
  for (const a of ACTIONS) {
    if (a.id === actionId) continue;
    const list = full[a.id] ?? [];
    const kept = list.filter((c) => !def.defaults.includes(c));
    if (kept.length !== list.length) {
      full[a.id] = kept;
      moved.push(a.label);
    }
  }
  return { overrides: toOverrides(full), moved };
}

// ---------- Events and display ----------

const MODIFIER_CODES = new Set([
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
  "AltLeft", "AltRight", "MetaLeft", "MetaRight", "CapsLock", "Fn",
]);

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/** Combo string for a key event, or null for a lone modifier or a Cmd shortcut. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  // Cmd combos are left to the OS and the app menu
  if (e.metaKey) return null;
  if (!e.code || e.code === "Unidentified" || isModifierCode(e.code)) return null;

  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(e.code);
  return parts.join("+");
}

// Keys that activate focused controls or leave dialogs; not assignable.
// (Space is a default for cine playback, but cannot be assigned again by hand.)
const RESERVED_CODES = new Set(["Escape", "Tab", "Enter", "NumpadEnter", "Space"]);

/** Returns a message if the combo cannot be assigned, otherwise null. */
export function checkCombo(combo: string): string | null {
  const code = combo.split("+").pop() ?? "";
  return RESERVED_CODES.has(code) ? `${formatCombo(combo)} is reserved and cannot be assigned` : null;
}

const CODE_NAMES: Record<string, string> = {
  ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→",
  Equal: "=", Minus: "-", Comma: ",", Period: ".", Slash: "/", Semicolon: ";",
  Quote: "'", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Backquote: "`",
  Space: "Space", PageUp: "Page Up", PageDown: "Page Down", Home: "Home", End: "End",
  Backspace: "⌫", Delete: "⌦",
  NumpadAdd: "Num +", NumpadSubtract: "Num −", NumpadMultiply: "Num ×",
  NumpadDivide: "Num ÷", NumpadDecimal: "Num .", NumpadEnter: "Num Enter",
};

// Combos that read better as the character they produce
const DISPLAY_OVERRIDES: Record<string, string> = {
  "Shift+Equal": "+",
  "Shift+Slash": "?",
};

function codeName(code: string): string {
  const named = CODE_NAMES[code];
  if (named) return named;
  const key = /^Key([A-Z])$/.exec(code);
  if (key?.[1]) return key[1];
  const digit = /^Digit(\d)$/.exec(code);
  if (digit?.[1]) return digit[1];
  const pad = /^Numpad(\d)$/.exec(code);
  if (pad?.[1]) return `Num ${pad[1]}`;
  return code;
}

// Names follow US key positions, since codes identify physical keys
export function formatCombo(combo: string): string {
  const special = DISPLAY_OVERRIDES[combo];
  if (special) return special;
  const parts = combo.split("+");
  const code = parts.pop() ?? "";
  return [...parts, codeName(code)].join(" + ");
}