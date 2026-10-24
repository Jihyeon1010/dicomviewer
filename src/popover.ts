// Opens and closes a floating panel with a short transition. The panel stays in the page
// (hidden) once the transition is over, so it takes no part in the layout or in tabbing.
const EXIT_MS = 180;
const timers = new WeakMap<HTMLElement, number>();

export function setPopover(pop: HTMLElement, open: boolean): void {
  const pending = timers.get(pop);
  if (pending !== undefined) window.clearTimeout(pending);
  timers.delete(pop);
  if (open) {
    if (!pop.hidden && pop.classList.contains("open")) return;
    pop.hidden = false;
    void pop.offsetWidth; // the start state must be drawn before the open state
    pop.classList.add("open");
  } else {
    if (pop.hidden) return;
    pop.classList.remove("open");
    timers.set(
      pop,
      window.setTimeout(() => {
        pop.hidden = true;
        timers.delete(pop);
      }, EXIT_MS),
    );
  }
}
