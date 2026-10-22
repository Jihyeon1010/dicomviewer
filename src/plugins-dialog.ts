import { byId } from "./dom";

// ---------- Types shared with the backend ----------

export type ParamValue = string | number | boolean;

export type PluginParam =
  | { id: string; label: string; type: "number"; default: number; min?: number; max?: number }
  | { id: string; label: string; type: "text"; default: string }
  | { id: string; label: string; type: "bool"; default: boolean }
  | { id: string; label: string; type: "choice"; default: string; options: string[] };

/** What plugin.json says about a plugin. */
export interface PluginInfo {
  id: string; // the folder name in the plugins folder
  name: string;
  version: string;
  description: string;
  entry: string; // the Python file that is run
  requires: string[]; // Python packages
  params: PluginParam[];
  enabled: boolean;
}

/** What the dialog needs from the application. The real one talks to the Rust side. */
export interface PluginBackend {
  list(): Promise<PluginInfo[]>;
  /** Reads plugin.json of a file, folder or zip without installing it. */
  inspect(path: string): Promise<PluginInfo>;
  install(path: string): Promise<PluginInfo>;
  remove(id: string): Promise<void>;
  setEnabled(id: string, on: boolean): Promise<void>;
  /** Runs the plugin; log lines are reported while it works. Rejects when it fails or is cancelled. */
  run(
    id: string,
    values: Record<string, ParamValue>,
    onLog: (line: string) => void,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface PluginsDialogDeps {
  backend: PluginBackend;
  pickFile(): Promise<string | null>;
  pickFolder(): Promise<string | null>;
}

export interface PluginsDialog {
  open(): Promise<void>;
  close(): void;
  isOpen(): boolean;
  /** Feed every keydown here first. Returns true when the dialog consumed the event. */
  handleKey(e: KeyboardEvent): boolean;
}

// ---------- Dialog ----------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text; // textContent only: manifests come from files (untrusted input)
  return e;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function createPluginsDialog(deps: PluginsDialogDeps): PluginsDialog {
  const backdrop = byId("plugins-backdrop", HTMLDivElement);
  const closeBtn = byId("plugins-close", HTMLButtonElement);
  const importFileBtn = byId("plugins-import-file", HTMLButtonElement);
  const importFolderBtn = byId("plugins-import-folder", HTMLButtonElement);
  const note = byId("plugins-note", HTMLDivElement);
  const list = byId("plugins-list", HTMLUListElement);
  const detail = byId("plugins-detail", HTMLElement);

  let plugins: PluginInfo[] = [];
  let selected: string | null = null;
  let opener: HTMLElement | null = null;
  let running: { id: string; abort: AbortController } | null = null;
  let logLines: string[] = [];

  const isOpen = (): boolean => !backdrop.hidden;
  const setNote = (text: string, error = false): void => {
    note.textContent = text;
    note.classList.toggle("error", error);
  };

  // ----- list -----

  function renderList(): void {
    if (plugins.length === 0) {
      const empty = el("li", "plugins-empty", "No plugins yet. Use Import file… or Import folder….");
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(
      ...plugins.map((p) => {
        const li = el("li");
        const b = el("button", "plugin-item");
        b.type = "button";
        b.classList.toggle("active", p.id === selected);
        b.classList.toggle("off", !p.enabled);
        b.append(el("span", "plugin-name", p.name), el("span", "plugin-meta", `v${p.version}`));
        if (p.description) b.append(el("span", "plugin-desc", p.description));
        b.addEventListener("click", () => select(p.id));
        li.append(b);
        return li;
      }),
    );
  }

  function select(id: string | null): void {
    selected = id;
    logLines = [];
    renderList();
    renderDetail();
  }

  // ----- the form of a plugin -----

  function field(p: PluginParam): { row: HTMLElement; read: () => ParamValue } {
    const row = el("label", "param-row");
    row.append(el("span", "param-label", p.label));
    switch (p.type) {
      case "number": {
        const input = el("input");
        input.type = "number";
        input.value = String(p.default);
        if (p.min !== undefined) input.min = String(p.min);
        if (p.max !== undefined) input.max = String(p.max);
        row.append(input);
        return { row, read: () => (Number.isFinite(input.valueAsNumber) ? input.valueAsNumber : p.default) };
      }
      case "bool": {
        const input = el("input");
        input.type = "checkbox";
        input.checked = p.default;
        row.append(input);
        return { row, read: () => input.checked };
      }
      case "choice": {
        const select = el("select");
        for (const o of p.options) select.append(new Option(o, o, false, o === p.default));
        row.append(select);
        return { row, read: () => select.value };
      }
      default: {
        const input = el("input");
        input.type = "text";
        input.value = p.default;
        row.append(input);
        return { row, read: () => input.value };
      }
    }
  }

  function renderDetail(): void {
    const p = plugins.find((x) => x.id === selected);
    if (!p) {
      detail.replaceChildren(el("div", "plugins-empty", "Choose a plugin to run it."));
      return;
    }

    const head = el("div", "plugin-head");
    head.append(el("h3", "", p.name), el("span", "plugin-meta", `v${p.version}`));
    const parts: HTMLElement[] = [head];
    if (p.description) parts.push(el("p", "plugin-text", p.description));
    if (p.requires.length > 0) {
      parts.push(el("p", "plugin-meta", `Needs Python packages: ${p.requires.join(", ")}`));
    }

    const form = el("form", "plugin-form");
    const fields = p.params.map(field);
    for (const f of fields) form.append(f.row);

    const actions = el("div", "plugin-actions");
    const runBtn = el("button", "primary", "Run");
    runBtn.type = "submit";
    const cancelBtn = el("button", "", "Cancel");
    cancelBtn.type = "button";
    const busy = running !== null;
    runBtn.disabled = busy || !p.enabled;
    cancelBtn.hidden = !(running && running.id === p.id);
    cancelBtn.addEventListener("click", () => running?.abort.abort());

    const toggle = el("button", "", p.enabled ? "Disable" : "Enable");
    toggle.type = "button";
    toggle.disabled = busy;
    toggle.addEventListener("click", () => void changeEnabled(p));
    const remove = el("button", "danger", "Remove");
    remove.type = "button";
    remove.disabled = busy;
    remove.addEventListener("click", () => void removePlugin(p));
    actions.append(runBtn, cancelBtn, el("span", "spacer"), toggle, remove);
    form.append(actions);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const values: Record<string, ParamValue> = {};
      p.params.forEach((q, i) => {
        const f = fields[i];
        if (f) values[q.id] = f.read();
      });
      void run(p, values);
    });
    parts.push(form);

    const log = el("pre", "plugin-log");
    log.id = "plugins-log";
    log.textContent = logLines.join("\n");
    parts.push(log);
    detail.replaceChildren(...parts);
  }

  // ----- actions -----

  function appendLog(line: string): void {
    logLines.push(line);
    const log = document.getElementById("plugins-log");
    if (log) {
      log.textContent = logLines.join("\n");
      log.scrollTop = log.scrollHeight;
    }
  }

  async function run(p: PluginInfo, values: Record<string, ParamValue>): Promise<void> {
    if (running) return;
    const abort = new AbortController();
    running = { id: p.id, abort };
    logLines = [];
    setNote(`Running ${p.name}…`);
    renderDetail();
    try {
      await deps.backend.run(p.id, values, appendLog, abort.signal);
      appendLog("Done.");
      setNote(`${p.name} finished.`);
    } catch (err) {
      appendLog(abort.signal.aborted ? "Cancelled." : `Error: ${message(err)}`);
      setNote(abort.signal.aborted ? `${p.name} was cancelled.` : `${p.name} failed.`, !abort.signal.aborted);
    } finally {
      running = null;
      renderDetail();
    }
  }

  async function changeEnabled(p: PluginInfo): Promise<void> {
    try {
      await deps.backend.setEnabled(p.id, !p.enabled);
      await reload();
    } catch (err) {
      setNote(message(err), true);
    }
  }

  async function removePlugin(p: PluginInfo): Promise<void> {
    if (!window.confirm(`Remove the plugin "${p.name}"? Its folder is deleted.`)) return;
    try {
      await deps.backend.remove(p.id);
      selected = null;
      setNote(`${p.name} was removed.`);
      await reload();
    } catch (err) {
      setNote(message(err), true);
    }
  }

  // Shows what is about to be installed and asks before anything is copied
  async function importFrom(path: string | null): Promise<void> {
    if (!path) return;
    let info: PluginInfo;
    try {
      info = await deps.backend.inspect(path);
    } catch (err) {
      setNote(`Cannot import: ${message(err)}`, true);
      return;
    }
    const card = el("div", "plugin-confirm");
    card.append(
      el("h3", "", `Import ${info.name} v${info.version}?`),
      el("p", "plugin-text", info.description || "No description."),
      el("p", "plugin-meta", `Source: ${path}`),
      el("p", "plugin-meta", `Runs: ${info.entry}`),
      el(
        "p",
        "plugin-warning",
        "A plugin is Python code. It runs on this computer with your permissions and can read and change your files. Import only code that you trust.",
      ),
    );
    const actions = el("div", "plugin-actions");
    const ok = el("button", "primary", "Import");
    ok.type = "button";
    const cancel = el("button", "", "Cancel");
    cancel.type = "button";
    actions.append(ok, cancel);
    card.append(actions);
    detail.replaceChildren(card);
    cancel.addEventListener("click", renderDetail);
    ok.addEventListener("click", () => {
      void (async () => {
        try {
          const installed = await deps.backend.install(path);
          setNote(`${installed.name} was imported.`);
          selected = installed.id;
          await reload();
        } catch (err) {
          setNote(`Import failed: ${message(err)}`, true);
          renderDetail();
        }
      })();
    });
  }

  async function reload(): Promise<void> {
    plugins = await deps.backend.list();
    if (selected && !plugins.some((p) => p.id === selected)) selected = null;
    renderList();
    renderDetail();
  }

  // ----- opening and closing -----

  async function open(): Promise<void> {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    backdrop.hidden = false;
    setNote("");
    closeBtn.focus();
    try {
      await reload();
    } catch (err) {
      setNote(`Cannot read the plugins: ${message(err)}`, true);
    }
  }

  function close(): void {
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
    // Everything else is left to the page, so typing in a field works,
    // but the viewer's shortcuts do not fire behind the dialog
    return true;
  }

  closeBtn.addEventListener("click", close);
  importFileBtn.addEventListener("click", () => void deps.pickFile().then(importFrom));
  importFolderBtn.addEventListener("click", () => void deps.pickFolder().then(importFrom));
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });

  return { open, close, isOpen, handleKey };
}