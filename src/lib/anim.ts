/** Maps scroll progress p into 0..1 over the window [a, b]. */
export const step = (p: number, a: number, b: number) =>
  Math.min(1, Math.max(0, (p - a) / (b - a)));

export const EASE = [0.22, 1, 0.36, 1] as const;
