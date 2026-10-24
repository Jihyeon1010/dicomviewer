import { byId } from "./dom";
import {
  ACTIONS,
  assign,
  checkCombo,
  comboFromEvent,
  formatCombo,
  isDefault,
  isModifierCode,
  resetAction,
  unassign,
  type Bindings,
} from "./keymap";

import {
  defaultSettings, MARKER_COLOR_IDS, MARKER_SIZES, OVERLAY_MODES, SENSITIVITIES, SLIDER_POSITIONS, TIME_COURSE_MODES,
  type Settings,
} from "./settings";
import { ORIENT_MODES } from "./orient-auto";

export interface DialogDeps {
  getBindings: () => Bindings;               // effective bindings for all actions
  onChange: (overrides: Bindings) => void;   // receives the new override map
  getSettings: () => Settings;
  change: (patch: Partial<Settings>) => void; // applies and stores a setting
  /** Looks for Python (the given path, or on its own when empty) and says what was found. */
  checkPython: (path: string) => Promise<string>;
  /** Lets the user choose a folder; null when they cancel. */
  pickFolder: () => Promise<string | null>;
}

// ---------- The settings of the pages ----------

type Field =
  | {
      kind: "select";
      label: string;
      hint?: string;
      options: [string, string][];
      get: (s: Settings) => string;
      set: (v: string) => Partial<Settings>;
    }
  | { kind: "toggle"; label: string; hint?: string; get: (s: Settings) => boolean; set: (v: boolean) => Partial<Settings> }
  | { kind: "python"; label: string; hint?: string }
  | { kind: "folder"; label: string; hint?: string };

interface Page {
  id: string;
  title: string;
  intro?: string;
  fields: Field[];
}

// The element of a list that has this value (the lists are what the stored values are checked against)
function pick<T extends string>(list: readonly T[], v: string): T | undefined {
  return list.find((x) => x === v);
}

const SPEED: [string, string][] = [["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"]];

const PAGES: Page[] = [
  {
    id: "display",
    title: "Display",
    fields: [
      {
        kind: "select",
        label: "Information on the images",
        options: [["full", "Full"], ["minimal", "Minimal"], ["off", "Off"]],
        get: (s) => s.overlay,
        set: (v) => {
          const overlay = pick(OVERLAY_MODES, v);
          return overlay ? { overlay } : {};
        },
      },
      {
        kind: "select",
        label: "Orientation",
        hint: "Standard shows images in the radiological convention; \"As stored\" keeps the order of the file.",
        options: [["standard", "Standard"], ["stored", "As stored"]],
        get: (s) => s.orientMode,
        set: (v) => {
          const orientMode = pick(ORIENT_MODES, v);
          return orientMode ? { orientMode } : {};
        },
      },
      {
        kind: "select",
        label: "Image slider",
        hint: "Where the slider that scrolls the images sits.",
        options: [["bottom", "Below the images"], ["right", "Right of the images"]],
        get: (s) => s.sliderPos,
        set: (v) => {
          const sliderPos = pick(SLIDER_POSITIONS, v);
          return sliderPos ? { sliderPos } : {};
        },
      },
      {
        kind: "toggle",
        label: "Orientation markers and scale bars",
        get: (s) => s.markers,
        set: (markers) => ({ markers }),
      },
      {
        kind: "toggle",
        label: "Smooth images when enlarged",
        hint: "Off shows every pixel as a sharp square, which is what you want for measuring.",
        get: (s) => s.smooth,
        set: (smooth) => ({ smooth }),
      },
    ],
  },
  {
    id: "mouse",
    title: "Mouse and scrolling",
    fields: [
      {
        kind: "toggle",
        label: "Reverse the wheel direction",
        get: (s) => s.wheelReverse,
        set: (wheelReverse) => ({ wheelReverse }),
      },
      {
        kind: "select",
        label: "Wheel speed",
        hint: "How much the wheel has to turn for the next image.",
        options: SPEED,
        get: (s) => s.wheelSensitivity,
        set: (v) => {
          const wheelSensitivity = pick(SENSITIVITIES, v);
          return wheelSensitivity ? { wheelSensitivity } : {};
        },
      },
      {
        kind: "select",
        label: "Scroll tool speed",
        hint: "How far the mouse has to move with the scroll tool for the next image.",
        options: SPEED,
        get: (s) => s.scrollSensitivity,
        set: (v) => {
          const scrollSensitivity = pick(SENSITIVITIES, v);
          return scrollSensitivity ? { scrollSensitivity } : {};
        },
      },
    ],
  },
  {
    id: "volume",
    title: "4D images (fMRI)",
    fields: [
      {
        kind: "select",
        label: "Time course of a voxel",
        hint: "Percent change shows each value relative to the mean of the voxel, which makes voxels of different brightness comparable.",
        options: [["raw", "Values of the image"], ["percent", "Percent change from the mean"]],
        get: (s) => s.timeCourseMode,
        set: (v) => {
          const timeCourseMode = pick(TIME_COURSE_MODES, v);
          return timeCourseMode ? { timeCourseMode } : {};
        },
      },
      {
        kind: "toggle",
        label: "Mark the voxel on the image",
        hint: "A cross shows where the time course was taken, on the image it was taken from.",
        get: (s) => s.timeMarker,
        set: (timeMarker) => ({ timeMarker }),
      },
      {
        kind: "select",
        label: "Size of the cross",
        hint: "\"Across the image\" draws lines from edge to edge.",
        options: [["small", "Small"], ["medium", "Medium"], ["large", "Large"], ["full", "Across the image"]],
        get: (s) => s.timeMarkerSize,
        set: (v) => {
          const timeMarkerSize = pick(MARKER_SIZES, v);
          return timeMarkerSize ? { timeMarkerSize } : {};
        },
      },
      {
        kind: "select",
        label: "Colour of the cross",
        options: [
          ["yellow", "Yellow"], ["red", "Red"], ["green", "Green"],
          ["cyan", "Cyan"], ["magenta", "Magenta"], ["white", "White"],
        ],
        get: (s) => s.timeMarkerColor,
        set: (v) => {
          const timeMarkerColor = pick(MARKER_COLOR_IDS, v);
          return timeMarkerColor ? { timeMarkerColor } : {};
        },
      },
    ],
  },
  {
    id: "export",
    title: "Export",
    intro: "Images and surfaces are saved from a window that asks for the name. This sets the folder it opens in.",
    fields: [
      {
        kind: "folder",
        label: "Folder for exported files",
        hint: "PNG images and surface files (STL, OBJ, PLY). Without a folder the window opens where the system puts it.",
      },
    ],
  },
  {
    id: "python",
    title: "Python",
    intro: "Plugins are written in Python, which is not part of this app. Leave the path empty to let the app look for it.",
    fields: [{ kind: "python", label: "Python program", hint: "For example /opt/homebrew/bin/python3" }],
  },
];

const KEYS_PAGE = { id: "keys", title: "Keyboard shortcuts" };

// The order of the list on the left
const NAV_ORDER = ["display", "mouse", "volume", "export", "keys", "python"];
const NAV_ITEMS = NAV_ORDER.flatMap((id) => {
  const p = id === KEYS_PAGE.id ? KEYS_PAGE : PAGES.find((x) => x.id === id);
  return p ? [p] : [];
});

export interface SettingsDialog {
  open(): void;
  close(): void;
  isOpen(): boolean;
  /** Feed every keydown here first. Returns true when the dialog consumed the event. */
  handleKey(e: KeyboardEvent): boolean;
}

export function createSettingsDialog(deps: DialogDeps): SettingsDialog {
  const backdrop = byId("settings-backdrop", HTMLDivElement);
  const closeBtn = byId("settings-close", HTMLButtonElement);
  const list = byId("keys-list", HTMLDivElement);
  const nav = byId("settings-nav", HTMLElement);
  const pageEl = byId("settings-page", HTMLDivElement);
  const keysPage = byId("keys-page", HTMLDivElement);
  const resetAllBtn = byId("keys-reset-all", HTMLButtonElement);
  const notice = byId("keys-notice", HTMLDivElement);

  let opener: HTMLElement | null = null;
  let capturing: string | null = null; // id of the action waiting for a key
  let page = PAGES[0]?.id ?? "display";

  const isOpen = (): boolean => !backdrop.hidden;
  const say = (text: string): void => {
    notice.textContent = text;
  };

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function render(focusAddFor?: string): void {
    const bindings = deps.getBindings();
    const nodes: HTMLElement[] = [];
    let group = "";

    for (const a of ACTIONS) {
      if (a.group !== group) {
        group = a.group;
        nodes.push(el("div", "keys-group", group));
      }

      const row = el("div", "keys-row");
      const chips = el("div", "keys-chips");

      for (const combo of bindings[a.id] ?? []) {
        const chip = el("span", "key-chip");
        const remove = el("button", "key-remove", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `Remove ${formatCombo(combo)} from ${a.label}`);
        remove.addEventListener("click", () => {
          deps.onChange(unassign(deps.getBindings(), a.id, combo));
          say("");
          render();
        });
        chip.append(el("span", "key-chip-text", formatCombo(combo)), remove);
        chips.append(chip);
      }

      const capturingThis = capturing === a.id;
      const add = el("button", "key-add" + (capturingThis ? " capturing" : ""),
        capturingThis ? "Press a key…" : "Add");
      add.type = "button";
      add.dataset["add"] = a.id;
      add.addEventListener("click", () => {
        capturing = capturingThis ? null : a.id;
        say(capturing ? "Press the key combination to add. Esc cancels." : "");
        render(a.id);
      });

      const reset = el("button", "key-reset", "Reset");
      reset.type = "button";
      // Hidden, not removed, so the rows keep their layout
      reset.style.visibility = isDefault(bindings, a.id) ? "hidden" : "visible";
      reset.addEventListener("click", () => {
        const r = resetAction(deps.getBindings(), a.id);
        deps.onChange(r.overrides);
        say(r.moved.length ? `Default keys taken back from: ${r.moved.join(", ")}` : "");
        render();
      });

      row.append(el("span", "keys-label", a.label), chips, add, reset);
      nodes.push(row);
    }

    list.replaceChildren(...nodes);
    if (focusAddFor) {
      list.querySelector<HTMLButtonElement>(`[data-add="${focusAddFor}"]`)?.focus();
    }
  }

  function stopCapture(): void {
    if (capturing === null) return;
    capturing = null;
    say("");
    if (isOpen()) render();
  }

  // ---------- Pages ----------

  function renderNav(): void {
    const items = NAV_ITEMS.map((p) => {
      const b = el("button", "nav-item" + (p.id === page ? " active" : ""), p.title);
      b.type = "button";
      b.setAttribute("aria-current", String(p.id === page));
      b.addEventListener("click", () => show(p.id));
      return b;
    });
    nav.replaceChildren(...items);
  }

  function renderPage(p: Page): void {
    const s = deps.getSettings();
    const nodes: HTMLElement[] = [el("h3", "page-title", p.title)];
    if (p.intro) nodes.push(el("p", "page-intro", p.intro));
    for (const f of p.fields) {
      const row = el("div", "set-row");
      const text = el("div", "set-text");
      text.append(el("div", "set-label", f.label));
      if (f.hint) text.append(el("div", "set-hint", f.hint));
      row.append(text);

      if (f.kind === "toggle") {
        const box = el("input", "set-toggle");
        box.type = "checkbox";
        box.checked = f.get(s);
        box.setAttribute("aria-label", f.label);
        box.addEventListener("change", () => deps.change(f.set(box.checked)));
        row.append(box);
      } else if (f.kind === "select") {
        const sel = el("select", "set-control");
        sel.setAttribute("aria-label", f.label);
        for (const [value, label] of f.options) sel.append(new Option(label, value));
        sel.value = f.get(s);
        sel.addEventListener("change", () => deps.change(f.set(sel.value)));
        row.append(sel);
      } else if (f.kind === "folder") {
        row.classList.add("set-wide");
        const input = el("input", "set-text-input");
        input.type = "text";
        input.readOnly = true;
        input.placeholder = "Not set";
        input.value = s.exportDir;
        input.setAttribute("aria-label", f.label);
        const choose = el("button", "set-check", "Choose…");
        choose.type = "button";
        const clear = el("button", "set-check", "Clear");
        clear.type = "button";
        clear.disabled = s.exportDir === "";
        choose.addEventListener("click", () => {
          deps
            .pickFolder()
            .then((dir) => {
              if (dir === null) return;
              deps.change({ exportDir: dir });
              input.value = dir;
              clear.disabled = false;
            })
            .catch(() => undefined);
        });
        clear.addEventListener("click", () => {
          deps.change({ exportDir: "" });
          input.value = "";
          clear.disabled = true;
        });
        const line = el("div", "set-line");
        line.append(input, choose, clear);
        text.append(line);
      } else {
        row.classList.add("set-wide");
        const input = el("input", "set-text-input");
        input.type = "text";
        input.placeholder = "Find it automatically";
        input.value = s.pythonPath;
        input.spellcheck = false;
        input.setAttribute("aria-label", f.label);
        const result = el("div", "set-result");
        result.setAttribute("role", "status");
        const check = el("button", "set-check", "Check");
        check.type = "button";
        input.addEventListener("change", () => deps.change({ pythonPath: input.value.trim() }));
        check.addEventListener("click", () => {
          deps.change({ pythonPath: input.value.trim() });
          result.textContent = "Looking for Python…";
          deps
            .checkPython(input.value.trim())
            .then((text) => {
              result.textContent = text;
            })
            .catch((err: unknown) => {
              result.textContent = err instanceof Error ? err.message : String(err);
            });
        });
        const line = el("div", "set-line");
        line.append(input, check);
        text.append(line, result);
      }
      nodes.push(row);
    }
    const reset = el("button", "set-reset", "Reset this page");
    reset.type = "button";
    reset.addEventListener("click", () => {
      const base = defaultSettings();
      let patch: Partial<Settings> = {};
      for (const f of p.fields) {
        if (f.kind === "python") patch = { ...patch, pythonPath: "" };
        else if (f.kind === "folder") patch = { ...patch, exportDir: "" };
        else if (f.kind === "toggle") patch = { ...patch, ...f.set(f.get(base)) };
        else patch = { ...patch, ...f.set(f.get(base)) };
      }
      deps.change(patch);
      renderPage(p);
    });
    nodes.push(reset);
    pageEl.replaceChildren(...nodes);
  }

  function show(id: string): void {
    capturing = null;
    say("");
    page = id;
    renderNav();
    const p = PAGES.find((x) => x.id === id);
    pageEl.hidden = !p;
    keysPage.hidden = p !== undefined;
    if (p) renderPage(p);
    else render();
  }

  function open(): void {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    capturing = null;
    say("");
    backdrop.hidden = false;
    show(page);
    closeBtn.focus();
  }

  function close(): void {
    capturing = null;
    backdrop.hidden = true;
    opener?.focus();
    opener = null;
  }

  function handleKey(e: KeyboardEvent): boolean {
    if (!isOpen()) return false;

    // Not capturing: swallow viewer shortcuts, but let Tab and Enter work natively
    if (capturing === null) {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
      return true;
    }

    e.preventDefault();
    e.stopPropagation();

    if (e.code === "Escape") {
      stopCapture();
      return true;
    }

    const combo = comboFromEvent(e);
    if (!combo) {
      if (e.metaKey && !isModifierCode(e.code)) {
        say("Shortcuts with the Cmd key are not supported");
      }
      return true; // a lone modifier: keep waiting for the actual key
    }

    const problem = checkCombo(combo);
    if (problem) {
      say(problem);
      return true; // stay in capture mode
    }

    const id = capturing;
    capturing = null;
    const result = assign(deps.getBindings(), id, combo);
    deps.onChange(result.overrides);
    say(result.moved.length
      ? `${formatCombo(combo)} moved here from: ${result.moved.join(", ")}`
      : "");
    render(id);
    return true;
  }

  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  resetAllBtn.addEventListener("click", () => {
    capturing = null;
    deps.onChange({});
    say("All shortcuts reset to defaults");
    render();
  });
  // Do not stay stuck in capture mode after switching apps
  window.addEventListener("blur", stopCapture);

  return { open, close, isOpen, handleKey };
}