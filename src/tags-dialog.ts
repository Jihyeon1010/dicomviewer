import { getTags } from "./api";
import { byId } from "./dom";
import type { TagEntry } from "./types";

export interface TagsDialogDeps {
  context(): { uid: string; index: number } | null;
  anonymize(): boolean;
}

export interface TagsDialog {
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
  /** Feed every keydown here first. Returns true when the dialog consumed the event. */
  handleKey(e: KeyboardEvent): boolean;
}

const MAX_ROWS = 2000;

// Identifying attributes hidden while Anonymize is on: the patient group, institution and
// physician names, and study/series/acquisition dates and times. This is not exhaustive:
// free-text and private attributes can still contain personal data.
const IDENTIFYING = new Set([
  "(0008,0020)", "(0008,0021)", "(0008,0022)", "(0008,0023)",
  "(0008,0030)", "(0008,0031)", "(0008,0032)", "(0008,0033)",
  "(0008,0080)", "(0008,0081)", "(0008,0090)", "(0008,1040)",
  "(0008,1048)", "(0008,1050)", "(0008,1070)",
]);

const isIdentifying = (tag: string): boolean =>
  tag.startsWith("(0010,") || IDENTIFYING.has(tag);

export function createTagsDialog(deps: TagsDialogDeps): TagsDialog {
  const backdrop = byId("tags-backdrop", HTMLDivElement);
  const closeBtn = byId("tags-close", HTMLButtonElement);
  const search = byId("tags-search", HTMLInputElement);
  const count = byId("tags-count", HTMLSpanElement);
  const note = byId("tags-note", HTMLDivElement);
  const list = byId("tags-list", HTMLDivElement);

  let entries: TagEntry[] = [];
  let opener: HTMLElement | null = null;
  let loadToken = 0;

  const isOpen = (): boolean => !backdrop.hidden;

  function cell(className: string, text: string): HTMLSpanElement {
    const s = document.createElement("span");
    s.className = className;
    s.textContent = text; // textContent only: values come from files (untrusted input)
    s.title = text;
    return s;
  }

  function render(): void {
    const q = search.value.trim().toLowerCase();
    const hide = deps.anonymize();
    const rows: HTMLElement[] = [];
    let matches = 0;

    for (const e of entries) {
      const value = hide && isIdentifying(e.tag) ? "(hidden)" : e.value;
      if (q && !`${e.tag} ${e.name} ${value}`.toLowerCase().includes(q)) continue;
      matches++;
      if (rows.length >= MAX_ROWS) continue;

      const row = document.createElement("div");
      row.className = "tag-row";
      row.style.paddingLeft = `${e.depth * 16}px`;
      row.append(
        cell("tag-id", e.tag),
        cell("tag-name", e.name),
        cell("tag-vr", e.vr),
        cell("tag-value", value),
      );
      rows.push(row);
    }

    list.replaceChildren(...rows);
    count.textContent =
      matches > rows.length
        ? `${matches} of ${entries.length} (showing the first ${rows.length})`
        : `${matches} of ${entries.length}`;
  }

  async function open(): Promise<void> {
    const ctx = deps.context();
    if (!ctx) return;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    backdrop.hidden = false;
    entries = [];
    search.value = "";
    list.replaceChildren();
    count.textContent = "";
    note.textContent = "Loading…";
    search.focus();

    const token = ++loadToken;
    try {
      const result = await getTags(ctx.uid, ctx.index);
      if (token !== loadToken) return; // closed or reopened meanwhile
      entries = result;
      note.textContent = deps.anonymize()
        ? "Anonymize is on: identifying values are hidden. Free-text and private attributes may still contain personal data."
        : "";
      render();
    } catch (err) {
      if (token === loadToken) {
        note.textContent = `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }
  }

  function close(): void {
    loadToken++;
    backdrop.hidden = true;
    opener?.focus();
    opener = null;
  }

  function handleKey(e: KeyboardEvent): boolean {
    if (!isOpen()) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    // Everything else is left to the page, so typing in the search box works,
    // but the viewer's shortcuts do not fire behind the dialog
    return true;
  }

  search.addEventListener("input", render);
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  return { open, close, isOpen, handleKey };
}