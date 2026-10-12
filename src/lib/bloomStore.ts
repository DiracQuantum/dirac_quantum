import type { BloomEffect } from "postprocessing";

// The bloom pass is driven from the frame loop (page-load burst). Mutations
// live here so React components only call functions.
const holder: { effect: BloomEffect | null } = { effect: null };

export function registerBloom(effect: BloomEffect | null) {
  holder.effect = effect;
}

export function driveBloom(hot: number) {
  if (holder.effect) holder.effect.intensity = 0.75 + 3.2 * hot;
}
