export function byId<T extends HTMLElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) throw new Error(`Element #${id} not found or has the wrong type`);
  return el;
}

export function byIdSvg<T extends SVGElement>(id: string, ctor: new () => T): T {
  const el = document.getElementById(id);
  if (!(el instanceof ctor)) throw new Error(`SVG element #${id} not found or has the wrong type`);
  return el;
}