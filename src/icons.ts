// Inline SVG icons on a 24 x 24 grid, drawn in a stroke style. The shapes follow the look
// of the Lucide set (ISC licence) but are written out here, so no dependency is needed.
const NS = "http://www.w3.org/2000/svg";

const ICONS = {
  file:
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/>' +
    '<path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  folder:
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',

  // Mouse tools
  sliders:
    '<path d="M4 8h10"/><path d="M18 8h2"/><path d="M4 16h2"/><path d="M10 16h10"/>' +
    '<circle cx="16" cy="8" r="2"/><circle cx="8" cy="16" r="2"/>',
  move:
    '<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>',
  zoom:
    '<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>',
  scroll: '<path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/>',

  // Measurement tools
  ruler:
    '<g transform="rotate(-45 12 12)"><rect x="1" y="8.5" width="22" height="7" rx="1.5"/>' +
    '<path d="M5 8.5v3M9 8.5v2M13 8.5v3M17 8.5v2"/></g>',
  angle: '<path d="M4 20h16M4 20L15 5"/><path d="M10 20a6 6 0 0 0-2.5-4.8"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="6"/>',
  rect: '<rect x="3" y="6" width="18" height="12" rx="1"/>',

  // Layout and linking
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18M12 3v18"/>',
  link:
    '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>' +
    '<path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',

  // Window and view
  contrast:
    '<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>',
  fit:
    '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  undo:
    '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5 5.5 5.5 0 0 1-5.5 5.5H11"/>',

  // Orientation
  "rotate-ccw": '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  "rotate-cw": '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  "flip-h":
    '<path d="M8 5 3 19h5z"/><path d="M16 5l5 14h-5z"/><path d="M12 3v2M12 8v2M12 14v2M12 19v2"/>',
  "flip-v":
    '<path d="M5 8l7-5 7 5z"/><path d="M5 16l7 5 7-5z"/><path d="M3 12h2M8 12h2M14 12h2M19 12h2"/>',

  // Cine
  play: '<path d="M6 4l14 8-14 8z"/>',
  pause: '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>',

  // Interface
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
  crosshair: '<circle cx="12" cy="12" r="8"/><path d="M22 12h-4M6 12H2M12 6V2M12 22v-4"/>',
  "panel-bottom": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15h18"/>',
  "panel-right": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
  "eye-off":
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/>',
  locate: '<circle cx="12" cy="12" r="3"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/>',
  orbit:
    '<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-30 12 12)"/>',
  globe:
    '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c3 3 3 13 0 16M12 4c-3 3-3 13 0 16"/>',
  compass:
    '<circle cx="12" cy="12" r="9"/><path d="M16.2 7.8 14 14l-6.2 2.2L10 10z"/>',
  aneurysm:
    '<path d="M8 20h8"/><path d="M9 20c0-4-4-5-4-9a7 7 0 0 1 14 0c0 4-4 5-4 9"/><path d="M8 20h8" />',
  calibrate:
    '<path d="M3 7h18M3 17h18M7 7v4M12 7v3M17 7v4M7 17v-4M12 17v-3M17 17v-4"/>',
  mpr: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="M3 8l9 5 9-5M12 13v8"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  cog:
    '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7"/>' +
    '<path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
};

export type IconName = keyof typeof ICONS;

function isIconName(name: string): name is IconName {
  return name in ICONS;
}

function build(name: IconName): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.75");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.innerHTML = ICONS[name]; // constant markup defined above, never user input
  return svg;
}

/** Fills every element marked with data-icon="name" with that icon. */
export function mountIcons(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>("[data-icon]")) {
    const name = el.dataset["icon"] ?? "";
    if (isIconName(name)) el.replaceChildren(build(name));
    else console.warn(`Unknown icon: ${name}`);
  }
}

/** Swaps the icon inside a button that has an .ic slot. */
export function setIcon(button: HTMLElement, name: IconName): void {
  button.querySelector<HTMLElement>(".ic")?.replaceChildren(build(name));
}

/** Changes the text inside a button that has a .lbl slot. */
export function setLabel(button: HTMLElement, text: string): void {
  const slot = button.querySelector<HTMLElement>(".lbl");
  if (slot) slot.textContent = text;
}