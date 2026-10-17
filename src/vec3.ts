export type V3 = [number, number, number];

export const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

export function unit(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 1e-12 ? scale(a, 1 / l) : a;
}

/** Rodrigues rotation of `a` about the unit vector `k` by `angle` (right-hand rule). */
export function rotateAbout(a: V3, k: V3, angle: number): V3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const kxa = cross(k, a);
  const kd = dot(k, a) * (1 - c);
  return [
    a[0] * c + kxa[0] * s + k[0] * kd,
    a[1] * c + kxa[1] * s + k[1] * kd,
    a[2] * c + kxa[2] * s + k[2] * kd,
  ];
}