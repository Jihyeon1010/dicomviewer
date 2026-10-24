// A menu that opens where the right mouse button was clicked. Items can open submenus on
// hover or with the arrow keys; it closes on a click elsewhere, on Esc and when the window
// changes. It only draws: what the items do is up to the caller.

export interface MenuItem {
  label: string;
  /** Shortcut or other short note on the right */
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  run?: () => void;
  children?: MenuEntry[];
}
export type MenuEntry = MenuItem | "separator";

const EXIT_MS = 120;

let root: HTMLDivElement | null = null;
let opener: HTMLElement | null = null;

export function isContextMenuOpen(): boolean {
  return root !== null;
}

export function closeContextMenu(): void {
  const r = root;
  if (!r) return;
  root = null;
  r.classList.remove("open");
  window.setTimeout(() => r.remove(), EXIT_MS);
  document.removeEventListener("mousedown", onOutside, true);
  window.removeEventListener("blur", closeContextMenu);
  window.removeEventListener("resize", closeContextMenu);
  window.removeEventListener("wheel", closeContextMenu, true);
  const back = opener;
  opener = null;
  if (back && document.contains(back)) back.focus({ preventScroll: true });
}

function onOutside(e: MouseEvent): void {
  if (root && e.target instanceof Node && root.contains(e.target)) return;
  closeContextMenu();
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function items(menu: HTMLElement): HTMLButtonElement[] {
  return [...menu.querySelectorAll<HTMLButtonElement>(":scope > .ctx-row > .ctx-item:not(:disabled)")];
}

function buildMenu(entries: MenuEntry[], sub: boolean): HTMLDivElement {
  const menu = el("div", sub ? "ctx ctx-sub" : "ctx");
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;

  // Two separators in a row, or one at an edge, would look like a mistake
  const clean = entries.filter((e, i) => e !== "separator" || (i > 0 && i < entries.length - 1 && entries[i - 1] !== "separator"));

  for (const entry of clean) {
    if (entry === "separator") {
      menu.append(el("div", "ctx-sep"));
      continue;
    }
    const row = el("div", "ctx-row");
    const b = el("button", "ctx-item");
    b.type = "button";
    b.tabIndex = -1;
    b.disabled = entry.disabled === true;
    b.setAttribute("role", entry.checked === undefined ? "menuitem" : "menuitemcheckbox");
    if (entry.checked !== undefined) b.setAttribute("aria-checked", String(entry.checked));
    b.append(el("span", "ctx-check", entry.checked ? "✓" : ""), el("span", "ctx-label", entry.label));
    if (entry.children) {
      b.setAttribute("aria-haspopup", "menu");
      b.append(el("span", "ctx-hint", "›"));
      row.append(buildMenu(entry.children, true));
      b.addEventListener("pointerenter", () => openSub(b));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        openSub(b);
      });
    } else {
      if (entry.hint) b.append(el("span", "ctx-hint", entry.hint));
      b.addEventListener("pointerenter", () => {
        closeSiblingSubs(b);
        b.focus({ preventScroll: true });
      });
      b.addEventListener("click", () => {
        const run = entry.run;
        closeContextMenu();
        run?.();
      });
    }
    row.prepend(b);
    menu.append(row);
  }
  return menu;
}

function subOf(b: HTMLElement): HTMLElement | null {
  return b.parentElement?.querySelector(":scope > .ctx-sub") ?? null;
}

function closeSiblingSubs(b: HTMLElement): void {
  for (const s of b.closest(".ctx")?.querySelectorAll(":scope > .ctx-row > .ctx-item.sub-open") ?? []) {
    if (s !== b) {
      s.classList.remove("sub-open");
      subOf(s as HTMLElement)?.classList.remove("show");
    }
  }
}

function openSub(b: HTMLElement): void {
  closeSiblingSubs(b);
  const sub = subOf(b);
  if (!sub) return;
  b.classList.add("sub-open");
  sub.classList.remove("flip-x", "flip-y");
  sub.classList.add("show");
  const r = sub.getBoundingClientRect();
  if (r.right > window.innerWidth - 4) sub.classList.add("flip-x");
  if (r.bottom > window.innerHeight - 4) sub.classList.add("flip-y");
}

function onKey(e: KeyboardEvent): void {
  const menu = root;
  if (!menu) return;
  e.stopPropagation(); // the viewer's shortcuts must not run behind the menu
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const current = (focused?.closest(".ctx") as HTMLElement | null) ?? menu;
  const list = items(current);
  const at = focused ? list.indexOf(focused as HTMLButtonElement) : -1;
  const move = (to: number): void => {
    const target = list[(to + list.length) % Math.max(list.length, 1)];
    if (!target) return;
    closeSiblingSubs(target);
    target.focus({ preventScroll: true });
  };
  switch (e.key) {
    case "Escape":
      e.preventDefault();
      closeContextMenu();
      break;
    case "ArrowDown":
      e.preventDefault();
      move(at + 1);
      break;
    case "ArrowUp":
      e.preventDefault();
      move(at < 0 ? -1 : at - 1);
      break;
    case "ArrowRight": {
      const sub = focused ? subOf(focused) : null;
      if (focused && sub) {
        e.preventDefault();
        openSub(focused);
        sub.querySelector<HTMLButtonElement>(":scope > .ctx-row > .ctx-item:not(:disabled)")?.focus({ preventScroll: true });
      }
      break;
    }
    case "ArrowLeft": {
      const parent = current.parentElement?.querySelector<HTMLElement>(":scope > .ctx-item") ?? null;
      if (parent && current.classList.contains("ctx-sub")) {
        e.preventDefault();
        parent.classList.remove("sub-open");
        subOf(parent)?.classList.remove("show");
        parent.focus({ preventScroll: true });
      }
      break;
    }
    case "Enter":
    case " ":
      if (focused instanceof HTMLButtonElement) {
        e.preventDefault();
        focused.click();
      }
      break;
    default:
      break;
  }
}

/** Opens the menu with its top left corner at the screen position (x, y), or as near as it fits. */
export function showContextMenu(x: number, y: number, entries: MenuEntry[]): void {
  closeContextMenu();
  const menu = buildMenu(entries, false);
  opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  menu.style.left = "0px";
  menu.style.top = "0px";
  document.body.append(menu);
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  // Opens toward the free side, so that the menu stays in the window
  const left = x + w > window.innerWidth - 4 ? Math.max(4, x - w) : x;
  const top = y + h > window.innerHeight - 4 ? Math.max(4, y - h) : y;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.transformOrigin = `${x - left}px ${y - top}px`; // grows out of the click
  root = menu;
  menu.addEventListener("keydown", onKey);
  document.addEventListener("mousedown", onOutside, true);
  window.addEventListener("blur", closeContextMenu);
  window.addEventListener("resize", closeContextMenu);
  window.addEventListener("wheel", closeContextMenu, { capture: true, passive: true });
  menu.addEventListener("contextmenu", (e) => e.preventDefault());
  void menu.offsetWidth; // the start state must be drawn first
  menu.classList.add("open");
  menu.focus({ preventScroll: true });
}
