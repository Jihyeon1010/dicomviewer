const NS = "http://www.w3.org/2000/svg";
const W = 320;
const H = 150;
const PAD = { l: 38, r: 8, t: 8, b: 16 };

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

function format(v: number): string {
  const a = Math.abs(v);
  return a >= 1000 || (a > 0 && a < 0.01) ? v.toExponential(1) : String(Math.round(v * 100) / 100);
}

/** The value of one voxel through all volumes of a 4D file, as a small graph over the images. */
export class TimeCoursePanel {
  private readonly head = document.createElement("div");
  private readonly title = document.createElement("span");
  private readonly note = document.createElement("div");
  private readonly svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
  private readonly now = svgEl("line", { class: "tc-now" });
  private values: number[] = [];
  /** The series the graph belongs to; null while the panel is hidden. */
  uid: string | null = null;

  /** `onPick` is told the volume (0-based) that the user clicked in the graph. */
  constructor(private readonly root: HTMLElement, private readonly onPick: (volume: number) => void) {
    this.head.className = "tc-head";
    this.title.className = "tc-title";
    const close = document.createElement("button");
    close.className = "tc-close";
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close the time course");
    close.addEventListener("click", () => this.hide());
    this.head.append(this.title, close);
    this.note.className = "tc-note";
    root.append(this.head, this.svg, this.note);
    this.svg.addEventListener("click", (e) => {
      const n = this.values.length;
      if (n < 2) return;
      const r = this.svg.getBoundingClientRect();
      const x = ((e.clientX - r.left) / r.width) * W;
      const t = Math.round(((x - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
      this.onPick(Math.min(n - 1, Math.max(0, t)));
    });
  }

  get shown(): boolean {
    return this.uid !== null;
  }

  show(uid: string, title: string, values: number[], current: number): void {
    this.uid = uid;
    this.values = values;
    this.title.textContent = title;
    this.root.hidden = false;
    this.draw(current);
  }

  hide(): void {
    this.uid = null;
    this.values = [];
    this.root.hidden = true;
  }

  /** Moves the marker to the volume that is shown. */
  setCurrent(volume: number): void {
    if (this.uid !== null) this.draw(volume);
  }

  private draw(current: number): void {
    const v = this.values;
    const n = v.length;
    let lo = Math.min(...v);
    let hi = Math.max(...v);
    if (!(hi > lo)) {
      lo -= 1;
      hi += 1;
    }
    const x = (i: number) => PAD.l + (n > 1 ? (i / (n - 1)) * (W - PAD.l - PAD.r) : 0);
    const y = (val: number) => PAD.t + (1 - (val - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const line = svgEl("polyline", { class: "tc-line", points: v.map((val, i) => `${x(i).toFixed(1)},${y(val).toFixed(1)}`).join(" ") });
    const label = (text: string, at: number, anchor: string, ly: number) => {
      const t = svgEl("text", { class: "tc-axis", x: String(at), y: String(ly), "text-anchor": anchor });
      t.textContent = text;
      return t;
    };
    const c = Math.min(Math.max(current, 0), Math.max(n - 1, 0));
    this.now.setAttribute("x1", String(x(c)));
    this.now.setAttribute("x2", String(x(c)));
    this.now.setAttribute("y1", String(PAD.t));
    this.now.setAttribute("y2", String(H - PAD.b));
    this.svg.replaceChildren(
      line,
      this.now,
      label(format(hi), PAD.l - 4, "end", PAD.t + 8),
      label(format(lo), PAD.l - 4, "end", H - PAD.b),
      label("1", PAD.l, "start", H - 3),
      label(String(n), W - PAD.r, "end", H - 3),
    );
    const mean = v.reduce((a, b) => a + b, 0) / n;
    this.note.textContent = `Volume ${c + 1}: ${format(v[c] ?? 0)} · mean ${format(mean)} · ${n} volumes`;
  }
}
