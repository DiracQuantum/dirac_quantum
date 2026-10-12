import { useSyncExternalStore } from "react";

/** `?motion=force` plays every animation even when the OS asks for reduced motion (used for visual checks). */
export function motionForced(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("motion") === "force";
}

/** True when the OS asks for reduced motion and nothing overrides it. Always false on the server. */
export function motionReduced(): boolean {
  if (typeof window === "undefined") return false;
  return !motionForced() && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const noSubscribe = () => () => {};

/** Hydration-safe `motionForced()`: false while the server HTML hydrates, then the real value. */
export function useMotionForced(): boolean {
  return useSyncExternalStore(noSubscribe, motionForced, () => false);
}
