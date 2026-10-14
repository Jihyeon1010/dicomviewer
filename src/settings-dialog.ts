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

export interface DialogDeps {
  getBindings: () => Bindings;               // effective bindings for all actions
  onChange: (overrides: Bindings) => void;   // receives the new override map
}

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
  const resetAllBtn = byId("keys-reset-all", HTMLButtonElement);
  const notice = byId("keys-notice", HTMLDivElement);

  let opener: HTMLElement | null = null;
  let capturing: string | null = null; // id of the action waiting for a key

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

  function open(): void {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    capturing = null;
    say("");
    backdrop.hidden = false;
    render();
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