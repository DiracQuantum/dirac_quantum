// Shared mutable state between the Quantum Pet card UI and its animated body.
// Mutations live in this module so React components only call functions.

export const petState = {
  /** Date.now() of the last gate click; the creature reacts with a superposition burst. */
  burstAt: -1,
};

/** Called from the gate buttons; the creature picks it up on its next frame. */
export function triggerBurst() {
  petState.burstAt = Date.now();
}

/**
 * Drag input for orbiting the body. x/y are clamped target rotations for the
 * depth picture (it only has one face); spinX/tiltY are the free orbit for a
 * real 3D model, which can turn all the way round.
 */
export const catInput = {
  x: 0,
  y: 0,
  spinX: 0,
  tiltY: 0,
  dragging: false,
};

export function beginDrag() {
  catInput.dragging = true;
}

export function moveDrag(dx: number, dy: number) {
  if (!catInput.dragging) return;
  catInput.x = Math.max(-0.55, Math.min(0.55, catInput.x + dx * 0.006));
  catInput.y = Math.max(-0.25, Math.min(0.25, catInput.y + dy * 0.004));
  catInput.spinX += dx * 0.009;
  catInput.tiltY = Math.max(-0.6, Math.min(0.6, catInput.tiltY + dy * 0.005));
}

export function endDrag() {
  catInput.dragging = false;
}

/** Lets a released drag drift back towards the idle sweep. Called once per frame. */
export function decayDrag() {
  if (catInput.dragging) return;
  catInput.x *= 0.985;
  catInput.y *= 0.985;
  catInput.tiltY *= 0.97;
}
