// Animation rigs for the Quantum Pet pictures. Every form is a square render on
// black; the rig says which parts of the picture move and how. Coordinates are
// UV space of the picture (0..1, v up). Ellipses are [cx, cy, rx, ry].
//
// Tune with /pet?form=<name>&catdebug=1: domes red, breath green, flaps blue,
// eyes magenta, pulse yellow. Flaps with an even index sway one way, odd the
// other; a phase of PI mirrors a pair (wings).

export type Ellipse = [number, number, number, number];

export interface Dome {
  e: Ellipse;
  /** relative height of this volume (1 = full depth) */
  h: number;
}

export interface Flap {
  e: Ellipse;
  /** pivot point the region rotates around */
  pivot: [number, number];
  /** idle sway amplitude in radians */
  amp: number;
  speed: number;
  phase: number;
  /** occasionally flicks like an ear */
  flick: boolean;
}

export interface FormRig {
  file: string;
  domes: Dome[];
  eyes: Ellipse[];
  flaps: Flap[];
  breath: { e: Ellipse; amp: number } | null;
  tilt: { e: Ellipse; pivot: [number, number]; amp: number; speed: number } | null;
  /** whole-picture rocking about its centre, radians */
  rock: { amp: number; speed: number };
  /** region whose glow pulses */
  pulse: { e: Ellipse; amp: number; speed: number } | null;
  /** how much the plane bulges */
  depth: number;
  /** optional 3D model (GLB under public); when present it replaces the depth picture */
  model?: string;
  /**
   * turn of the model about its vertical axis, radians, so a model exported
   * facing sideways faces the camera at phase zero of its idle turn; find the
   * value with /pet?form=<name>&yaw=<radians> (default 0)
   */
  modelYaw?: number;
}

export const MAX_DOMES = 6;
export const MAX_FLAPS = 6;
export const MAX_EYES = 2;

const PI = Math.PI;

const cat: FormRig = {
  file: "pet-cat.webp",
  model: "/models/pet-cat.glb",
  domes: [
    { e: [0.49, 0.705, 0.19, 0.185], h: 1 },
    { e: [0.52, 0.36, 0.22, 0.31], h: 0.95 },
    { e: [0.385, 0.845, 0.085, 0.1], h: 0.55 },
    { e: [0.635, 0.815, 0.085, 0.1], h: 0.55 },
    { e: [0.6, 0.155, 0.17, 0.085], h: 0.45 },
  ],
  eyes: [
    [0.378, 0.703, 0.032, 0.026],
    [0.515, 0.672, 0.032, 0.026],
  ],
  flaps: [
    { e: [0.385, 0.845, 0.085, 0.1], pivot: [0.41, 0.77], amp: 0.015, speed: 1.7, phase: 0, flick: true },
    { e: [0.635, 0.815, 0.085, 0.1], pivot: [0.6, 0.745], amp: 0.015, speed: 1.9, phase: 1, flick: true },
    { e: [0.6, 0.155, 0.17, 0.085], pivot: [0.5, 0.2], amp: 0.07, speed: 1.2, phase: 0, flick: false },
  ],
  breath: { e: [0.52, 0.36, 0.22, 0.31], amp: 0.014 },
  tilt: { e: [0.49, 0.705, 0.19, 0.185], pivot: [0.5, 0.56], amp: 0.03, speed: 0.6 },
  rock: { amp: 0, speed: 0 },
  pulse: null,
  depth: 0.16,
};

const virus: FormRig = {
  file: "pet-virus.webp",
  model: "/models/pet-virus.glb",
  domes: [
    { e: [0.5, 0.48, 0.27, 0.27], h: 1 },
    { e: [0.5, 0.48, 0.47, 0.47], h: 0.35 },
  ],
  eyes: [
    [0.39, 0.505, 0.058, 0.046],
    [0.602, 0.5, 0.058, 0.046],
  ],
  flaps: [
    { e: [0.5, 0.865, 0.085, 0.11], pivot: [0.5, 0.73], amp: 0.06, speed: 1.3, phase: 0, flick: true },
    { e: [0.5, 0.13, 0.085, 0.11], pivot: [0.5, 0.26], amp: 0.06, speed: 1.1, phase: 2, flick: false },
    { e: [0.16, 0.633, 0.1, 0.085], pivot: [0.3, 0.6], amp: 0.06, speed: 1.5, phase: 1, flick: true },
    { e: [0.84, 0.65, 0.1, 0.085], pivot: [0.72, 0.6], amp: 0.06, speed: 1.4, phase: 3, flick: false },
  ],
  breath: { e: [0.5, 0.48, 0.47, 0.47], amp: 0.018 },
  tilt: null,
  rock: { amp: 0.05, speed: 0.5 },
  pulse: { e: [0.5, 0.48, 0.3, 0.3], amp: 0.25, speed: 1.6 },
  depth: 0.18,
};

const blackHole: FormRig = {
  file: "pet-black-hole.webp",
  model: "/models/pet-black-hole.glb",
  domes: [
    { e: [0.498, 0.585, 0.245, 0.245], h: 1 },
    { e: [0.51, 0.49, 0.47, 0.2], h: 0.25 },
  ],
  eyes: [
    [0.403, 0.49, 0.055, 0.03],
    [0.614, 0.53, 0.055, 0.03],
  ],
  flaps: [{ e: [0.51, 0.49, 0.47, 0.2], pivot: [0.498, 0.585], amp: 0.04, speed: 0.45, phase: 0, flick: false }],
  breath: { e: [0.498, 0.585, 0.245, 0.245], amp: 0.008 },
  tilt: null,
  rock: { amp: 0.035, speed: 0.4 },
  pulse: { e: [0.51, 0.49, 0.47, 0.2], amp: 0.35, speed: 0.9 },
  depth: 0.2,
};

const cube: FormRig = {
  file: "pet-cube.webp",
  model: "/models/pet-cube.glb",
  domes: [{ e: [0.5, 0.52, 0.37, 0.36], h: 1 }],
  eyes: [
    [0.375, 0.517, 0.058, 0.05],
    [0.634, 0.513, 0.058, 0.05],
  ],
  flaps: [],
  breath: { e: [0.5, 0.52, 0.37, 0.36], amp: 0.012 },
  tilt: null,
  rock: { amp: 0.08, speed: 0.9 },
  pulse: { e: [0.5, 0.52, 0.3, 0.3], amp: 0.2, speed: 1.3 },
  depth: 0.17,
};

const jellyfish: FormRig = {
  file: "pet-jellyfish.webp",
  model: "/models/pet-jellyfish.glb",
  domes: [
    { e: [0.5, 0.77, 0.215, 0.15], h: 1 },
    { e: [0.31, 0.39, 0.13, 0.3], h: 0.3 },
    { e: [0.415, 0.345, 0.1, 0.33], h: 0.35 },
    { e: [0.54, 0.34, 0.1, 0.33], h: 0.35 },
    { e: [0.69, 0.39, 0.13, 0.3], h: 0.3 },
  ],
  eyes: [
    [0.467, 0.769, 0.03, 0.028],
    [0.586, 0.746, 0.03, 0.028],
  ],
  flaps: [
    { e: [0.31, 0.39, 0.13, 0.3], pivot: [0.42, 0.66], amp: 0.05, speed: 0.9, phase: 0, flick: false },
    { e: [0.415, 0.345, 0.1, 0.33], pivot: [0.47, 0.66], amp: 0.04, speed: 1.1, phase: 1.2, flick: false },
    { e: [0.54, 0.34, 0.1, 0.33], pivot: [0.53, 0.66], amp: 0.04, speed: 1.0, phase: 2.4, flick: false },
    { e: [0.69, 0.39, 0.13, 0.3], pivot: [0.58, 0.66], amp: 0.05, speed: 0.8, phase: 3.6, flick: false },
  ],
  breath: { e: [0.5, 0.77, 0.215, 0.15], amp: 0.03 },
  tilt: null,
  rock: { amp: 0.02, speed: 0.5 },
  pulse: { e: [0.5, 0.77, 0.2, 0.14], amp: 0.25, speed: 1.0 },
  depth: 0.15,
};

const moth: FormRig = {
  file: "pet-moth.webp",
  model: "/models/pet-moth.glb",
  domes: [
    { e: [0.5, 0.43, 0.09, 0.25], h: 1 },
    { e: [0.5, 0.625, 0.07, 0.07], h: 0.9 },
    { e: [0.24, 0.665, 0.24, 0.2], h: 0.25 },
    { e: [0.765, 0.665, 0.24, 0.2], h: 0.25 },
    { e: [0.287, 0.346, 0.18, 0.17], h: 0.2 },
    { e: [0.718, 0.346, 0.18, 0.17], h: 0.2 },
  ],
  eyes: [
    [0.47, 0.633, 0.022, 0.02],
    [0.533, 0.633, 0.022, 0.02],
  ],
  flaps: [
    { e: [0.24, 0.665, 0.24, 0.2], pivot: [0.44, 0.58], amp: 0.05, speed: 2.2, phase: 0, flick: false },
    { e: [0.765, 0.665, 0.24, 0.2], pivot: [0.56, 0.58], amp: 0.05, speed: 2.2, phase: PI, flick: false },
    { e: [0.287, 0.346, 0.18, 0.17], pivot: [0.44, 0.47], amp: 0.04, speed: 2.2, phase: 0.3, flick: false },
    { e: [0.718, 0.346, 0.18, 0.17], pivot: [0.56, 0.47], amp: 0.04, speed: 2.2, phase: PI + 0.3, flick: false },
    { e: [0.375, 0.76, 0.08, 0.08], pivot: [0.47, 0.67], amp: 0.03, speed: 1.6, phase: 0, flick: true },
    { e: [0.63, 0.76, 0.08, 0.08], pivot: [0.53, 0.67], amp: 0.03, speed: 1.6, phase: PI, flick: true },
  ],
  breath: { e: [0.5, 0.43, 0.09, 0.25], amp: 0.01 },
  tilt: null,
  rock: { amp: 0.03, speed: 0.6 },
  pulse: null,
  depth: 0.14,
};

const fox: FormRig = {
  file: "pet-fox.webp",
  model: "/models/pet-fox.glb",
  domes: [
    { e: [0.526, 0.68, 0.17, 0.17], h: 1 },
    { e: [0.526, 0.378, 0.2, 0.3], h: 0.95 },
    { e: [0.415, 0.816, 0.075, 0.1], h: 0.55 },
    { e: [0.622, 0.816, 0.075, 0.1], h: 0.55 },
    { e: [0.375, 0.218, 0.15, 0.13], h: 0.5 },
  ],
  eyes: [
    [0.482, 0.675, 0.028, 0.022],
    [0.576, 0.675, 0.028, 0.022],
  ],
  flaps: [
    { e: [0.415, 0.816, 0.075, 0.1], pivot: [0.47, 0.72], amp: 0.015, speed: 1.7, phase: 0, flick: true },
    { e: [0.622, 0.816, 0.075, 0.1], pivot: [0.58, 0.72], amp: 0.015, speed: 1.9, phase: 1, flick: true },
    { e: [0.375, 0.218, 0.15, 0.13], pivot: [0.5, 0.3], amp: 0.06, speed: 1.1, phase: 0, flick: false },
  ],
  breath: { e: [0.526, 0.378, 0.2, 0.3], amp: 0.014 },
  tilt: { e: [0.526, 0.68, 0.17, 0.17], pivot: [0.52, 0.55], amp: 0.03, speed: 0.6 },
  rock: { amp: 0, speed: 0 },
  pulse: null,
  depth: 0.16,
};

const crystal: FormRig = {
  file: "pet-crystal.webp",
  model: "/models/pet-crystal.glb",
  domes: [
    { e: [0.5, 0.48, 0.27, 0.42], h: 1 },
    { e: [0.51, 0.76, 0.09, 0.17], h: 0.9 },
  ],
  eyes: [
    [0.488, 0.785, 0.025, 0.02],
    [0.558, 0.785, 0.025, 0.02],
  ],
  flaps: [
    { e: [0.32, 0.617, 0.09, 0.15], pivot: [0.4, 0.5], amp: 0.015, speed: 0.7, phase: 0, flick: false },
    { e: [0.67, 0.625, 0.09, 0.15], pivot: [0.6, 0.5], amp: 0.015, speed: 0.8, phase: PI, flick: false },
    { e: [0.303, 0.44, 0.08, 0.12], pivot: [0.42, 0.4], amp: 0.012, speed: 0.9, phase: 1, flick: false },
    { e: [0.71, 0.44, 0.08, 0.12], pivot: [0.6, 0.4], amp: 0.012, speed: 0.75, phase: PI + 1, flick: false },
  ],
  breath: { e: [0.5, 0.48, 0.27, 0.42], amp: 0.006 },
  tilt: { e: [0.51, 0.76, 0.09, 0.17], pivot: [0.51, 0.6], amp: 0.02, speed: 0.5 },
  rock: { amp: 0.025, speed: 0.5 },
  pulse: { e: [0.5, 0.5, 0.26, 0.4], amp: 0.3, speed: 0.8 },
  depth: 0.18,
};

export const FORM_RIGS: Record<string, FormRig> = {
  cat,
  virus,
  "black hole": blackHole,
  cube,
  jellyfish,
  moth,
  fox,
  crystal,
};

/** Rig for a form; forms without art yet borrow the cat. */
export function rigFor(form: string | null | undefined): { rig: FormRig; borrowed: boolean } {
  const key = (form ?? "").toLowerCase();
  const rig = FORM_RIGS[key];
  return rig ? { rig, borrowed: false } : { rig: cat, borrowed: true };
}
