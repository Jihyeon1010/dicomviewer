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

const MARGIN = 12;
const EXIT_MS = 180;
const REST_RESPONSE = 0.4; // seconds; Apple's value for repositioning
const DECELERATION = 0.998;
const reducedMotion = (): boolean => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type Corner = { right: boolean; bottom: boolean };

// A pointer that jumps between two events gives a speed that is no use
const MAX_SPEED = 4000; // px/s
const clampSpeed = (v: number): number => Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));

// Where a throw ends if it is let go with this velocity (px/s)
function project(velocity: number): number {
  return ((velocity / 1000) * DECELERATION) / (1 - DECELERATION);
}

// The further past the edge, the less the panel follows the pointer
function rubberband(over: number, size: number): number {
  const c = 0.55;
  return (Math.sign(over) * (Math.abs(over) * size * c)) / (size + c * Math.abs(over));
}

/**
 * The value of one voxel through all volumes of a 4D file, as a small graph over the images.
 * It grows out of the place that was clicked and can be moved: it follows the pointer 1:1,
 * and when let go it flies on with the pointer's speed and settles in the nearest corner.
 */
export class TimeCoursePanel {
  private readonly card = document.createElement("div");
  private readonly head = document.createElement("div");
  private readonly title = document.createElement("span");
  private readonly note = document.createElement("div");
  private readonly svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
  private readonly now = svgEl("line", { class: "tc-now" });
  private values: number[] = [];
  /** The series the graph belongs to; null while the panel is hidden. */
  uid: string | null = null;
  /** Called when the panel is closed or hidden, for example to remove the mark from the image. */
  onHide: (() => void) | null = null;
  private current = 0;
  private unit = "";

  private pos = { x: 0, y: 0 }; // top left corner, relative to the root's parent
  private corner: Corner = { right: true, bottom: true };
  private raf = 0;
  private hideTimer = 0;
  private drag: { dx: number; dy: number; samples: { t: number; x: number; y: number }[] } | null = null;

  /**
   * `area` is the element the panel stays inside. `onPick` is told the volume (0-based) that
   * the user clicked in the graph.
   */
  constructor(
    private readonly root: HTMLElement,
    private readonly area: HTMLElement,
    private readonly onPick: (volume: number) => void,
  ) {
    this.card.className = "tc-card";
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
    this.card.append(this.head, this.svg, this.note);
    root.append(this.card);
    this.head.addEventListener("pointerdown", (e) => this.dragStart(e));
    this.head.addEventListener("pointermove", (e) => this.dragMove(e));
    this.head.addEventListener("pointerup", (e) => this.dragEnd(e));
    this.head.addEventListener("pointercancel", (e) => this.dragEnd(e));
    window.addEventListener("resize", () => {
      if (this.uid !== null && !this.drag) this.place(this.target(this.corner));
    });
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

  /** `from` is the screen position the panel grows out of when it opens. */
  show(uid: string, title: string, values: number[], current: number, from?: { x: number; y: number }, unit = ""): void {
    const opening = this.uid === null;
    this.uid = uid;
    this.values = values;
    this.unit = unit;
    this.title.textContent = title;
    this.draw(current);
    window.clearTimeout(this.hideTimer);
    if (!opening) return;
    this.root.hidden = false;
    this.place(this.target(this.corner));
    // Grow out of the click, so that the graph and the voxel belong together
    const r = this.root.getBoundingClientRect();
    const near = (v: number) => Math.max(-400, Math.min(640, v));
    if (from) this.card.style.transformOrigin = `${near(from.x - r.left)}px ${near(from.y - r.top)}px`;
    this.card.classList.remove("open");
    void this.card.offsetWidth;
    this.card.classList.add("open");
  }

  /** The same voxel with other values, for example in another unit. */
  setValues(values: number[], unit: string): void {
    if (this.uid === null) return;
    this.values = values;
    this.unit = unit;
    this.draw(this.current);
  }

  hide(): void {
    if (this.uid === null && this.root.hidden) return;
    if (this.uid !== null) this.onHide?.();
    this.uid = null;
    this.values = [];
    cancelAnimationFrame(this.raf);
    this.card.classList.remove("open");
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      this.root.hidden = true;
    }, EXIT_MS);
  }

  // ---------- Position ----------

  private place(p: { x: number; y: number }): void {
    this.pos = p;
    this.root.style.transform = `translate(${p.x}px, ${p.y}px)`;
  }

  // The room the panel has: the area, in the coordinates of the root's parent
  private limits(): { minX: number; maxX: number; minY: number; maxY: number } {
    const parent = (this.root.offsetParent ?? this.root.parentElement ?? this.area).getBoundingClientRect();
    const a = this.area.getBoundingClientRect();
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    const minX = a.left - parent.left + MARGIN;
    const minY = a.top - parent.top + MARGIN;
    return {
      minX,
      minY,
      maxX: Math.max(minX, a.right - parent.left - w - MARGIN),
      maxY: Math.max(minY, a.bottom - parent.top - h - MARGIN),
    };
  }

  private target(c: Corner): { x: number; y: number } {
    const l = this.limits();
    return { x: c.right ? l.maxX : l.minX, y: c.bottom ? l.maxY : l.minY };
  }

  private dragStart(e: PointerEvent): void {
    if (e.button !== 0 || (e.target instanceof HTMLElement && e.target.closest("button"))) return;
    cancelAnimationFrame(this.raf); // grabbing a flying panel stops it where it is
    this.head.setPointerCapture(e.pointerId);
    this.drag = { dx: e.clientX - this.pos.x, dy: e.clientY - this.pos.y, samples: [] };
    this.sample(e);
    this.root.classList.add("dragging");
    e.preventDefault();
  }

  private sample(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    d.samples.push({ t: e.timeStamp, x: e.clientX, y: e.clientY });
    while (d.samples.length > 2 && e.timeStamp - (d.samples[0]?.t ?? 0) > 100) d.samples.shift();
  }

  private dragMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.sample(e);
    const l = this.limits();
    const soft = (v: number, lo: number, hi: number, size: number) =>
      v < lo ? lo + rubberband(v - lo, size) : v > hi ? hi + rubberband(v - hi, size) : v;
    const a = this.area.getBoundingClientRect();
    this.place({
      x: soft(e.clientX - d.dx, l.minX, l.maxX, a.width),
      y: soft(e.clientY - d.dy, l.minY, l.maxY, a.height),
    });
  }

  private dragEnd(e: PointerEvent): void {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.root.classList.remove("dragging");
    if (this.head.hasPointerCapture(e.pointerId)) this.head.releasePointerCapture(e.pointerId);
    // The pointer's speed over the last moments
    const first = d.samples[0];
    const last = d.samples[d.samples.length - 1];
    let vx = 0;
    let vy = 0;
    if (first && last && last.t - first.t >= 8) {
      vx = clampSpeed(((last.x - first.x) / (last.t - first.t)) * 1000);
      vy = clampSpeed(((last.y - first.y) / (last.t - first.t)) * 1000);
    }
    // The corner that the throw is heading for, not the one nearest to where it was let go
    const l = this.limits();
    const endX = this.pos.x + project(vx);
    const endY = this.pos.y + project(vy);
    this.corner = { right: endX > (l.minX + l.maxX) / 2, bottom: endY > (l.minY + l.maxY) / 2 };
    const to = this.target(this.corner);
    if (reducedMotion()) this.place(to);
    else this.fly(to, vx, vy);
  }

  // A critically damped spring from where the panel is, with the speed it was let go with
  private fly(to: { x: number; y: number }, vx: number, vy: number): void {
    cancelAnimationFrame(this.raf);
    const w = (2 * Math.PI) / REST_RESPONSE;
    let v = { x: vx, y: vy };
    const l = this.limits();
    const slack = 24; // a throw may carry the panel a little past the edge, not off the screen
    const keep = (p: number, lo: number, hi: number) => Math.max(lo - slack, Math.min(hi + slack, p));
    let last = performance.now();
    const step = (now: number) => {
      let dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      while (dt > 0) {
        const h = Math.min(dt, 1 / 240);
        v = {
          x: v.x + (-w * w * (this.pos.x - to.x) - 2 * w * v.x) * h,
          y: v.y + (-w * w * (this.pos.y - to.y) - 2 * w * v.y) * h,
        };
        this.pos = {
          x: keep(this.pos.x + v.x * h, l.minX, l.maxX),
          y: keep(this.pos.y + v.y * h, l.minY, l.maxY),
        };
        dt -= h;
      }
      const done = Math.hypot(this.pos.x - to.x, this.pos.y - to.y) < 0.2 && Math.hypot(v.x, v.y) < 2;
      this.place(done ? to : this.pos);
      if (!done) this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  /** Moves the marker to the volume that is shown. */
  setCurrent(volume: number): void {
    if (this.uid !== null) this.draw(volume);
  }

  private draw(current: number): void {
    this.current = current;
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
    this.note.textContent = this.unit
      ? `Volume ${c + 1}: ${format(v[c] ?? 0)} ${this.unit} · ${n} volumes`
      : `Volume ${c + 1}: ${format(v[c] ?? 0)} · mean ${format(mean)} · ${n} volumes`;
  }
}
