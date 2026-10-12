import { useSyncExternalStore } from "react";

// The page-load burst has one clock shared by the CSS flash, the particle
// scene and the hero text. It starts when the scene draws its first real
// frame (or on a fallback timer if it never does), so the three never drift
// apart. Mutations live here so React components only call functions.
const state = { startedAt: -1 };
const listeners = new Set<() => void>();

export function startIntro() {
  if (state.startedAt >= 0) return;
  state.startedAt = performance.now();
  for (const l of listeners) l();
}

export function introStarted(): boolean {
  return state.startedAt >= 0;
}

/** Runs the listener when the burst starts (not retroactively). */
export function subscribeIntro(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const serverSnapshot = () => false;

export function useIntroStarted(): boolean {
  return useSyncExternalStore(subscribeIntro, introStarted, serverSnapshot);
}
