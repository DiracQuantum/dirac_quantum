// Particle formations the background scene morphs between while scrolling.
// Index order matters: section N on the page maps to targets[N].
//   0 hero       -> cubic lattice (ML-KEM is lattice-based)
//   1 scanner    -> radar disc
//   2 passport   -> Bloch sphere
//   3 seal       -> ring of a seal
//   4 inbox      -> two parties with an encrypted stream between them
//   5 playground -> organic creature blob
//   6 token      -> coin

export const PARTICLE_COUNT = 14 * 14 * 14; // 2744
export const SCENE_COUNT = 7;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rnd = () => number;

function rotateX(arr: Float32Array, a: number) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (let i = 0; i < arr.length; i += 3) {
    const y = arr[i + 1];
    const z = arr[i + 2];
    arr[i + 1] = y * c - z * s;
    arr[i + 2] = y * s + z * c;
  }
}

function rotateY(arr: Float32Array, a: number) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (let i = 0; i < arr.length; i += 3) {
    const x = arr[i];
    const z = arr[i + 2];
    arr[i] = x * c + z * s;
    arr[i + 2] = -x * s + z * c;
  }
}

function lattice(rnd: Rnd) {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  const side = 14;
  const step = 0.4;
  const half = ((side - 1) * step) / 2;
  let k = 0;
  for (let x = 0; x < side; x++) {
    for (let y = 0; y < side; y++) {
      for (let z = 0; z < side; z++) {
        arr[k++] = x * step - half + (rnd() - 0.5) * 0.03;
        arr[k++] = y * step - half + (rnd() - 0.5) * 0.03;
        arr[k++] = z * step - half + (rnd() - 0.5) * 0.03;
      }
    }
  }
  rotateY(arr, 0.6);
  rotateX(arr, 0.35);
  return arr;
}

function disc(rnd: Rnd) {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const ring = Math.floor(rnd() * 7);
    const r = 0.45 + ring * 0.42 + (rnd() - 0.5) * 0.05;
    const a = rnd() * Math.PI * 2;
    arr[i * 3] = Math.cos(a) * r;
    arr[i * 3 + 1] = Math.sin(a) * r;
    arr[i * 3 + 2] = (rnd() - 0.5) * 0.12;
  }
  rotateX(arr, -1.05);
  return arr;
}

function sphere(rnd: Rnd) {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  const golden = Math.PI * (1 + Math.sqrt(5));
  const r = 2.3;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const phi = Math.acos(1 - (2 * (i + 0.5)) / PARTICLE_COUNT);
    const theta = golden * i;
    const jitter = 1 + (rnd() - 0.5) * 0.02;
    arr[i * 3] = Math.sin(phi) * Math.cos(theta) * r * jitter;
    arr[i * 3 + 1] = Math.cos(phi) * r * jitter;
    arr[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r * jitter;
  }
  return arr;
}

function ring(rnd: Rnd) {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  const R = 2.2;
  const r = 0.28;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const u = rnd() * Math.PI * 2;
    const v = rnd() * Math.PI * 2;
    arr[i * 3] = (R + r * Math.cos(v)) * Math.cos(u);
    arr[i * 3 + 1] = (R + r * Math.cos(v)) * Math.sin(u);
    arr[i * 3 + 2] = r * Math.sin(v);
  }
  rotateX(arr, 1.05);
  return arr;
}

function stream(rnd: Rnd) {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const pick = rnd();
    if (pick < 0.7) {
      // two parties
      const left = pick < 0.35;
      const cx = left ? -2.8 : 2.8;
      const cy = left ? 0.3 : -0.3;
      const rr = 0.85 * Math.cbrt(rnd());
      const phi = Math.acos(1 - 2 * rnd());
      const theta = rnd() * Math.PI * 2;
      arr[i * 3] = cx + Math.sin(phi) * Math.cos(theta) * rr;
      arr[i * 3 + 1] = cy + Math.cos(phi) * rr;
      arr[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * rr;
    } else {
      // encrypted stream between them
      const s = rnd();
      const x = -2.8 + s * 5.6;
      const y = 0.3 - 0.6 * s + 0.55 * Math.sin(s * Math.PI * 2);
      const z = 0.45 * Math.cos(s * Math.PI * 2);
      arr[i * 3] = x + (rnd() - 0.5) * 0.14;
      arr[i * 3 + 1] = y + (rnd() - 0.5) * 0.14;
      arr[i * 3 + 2] = z + (rnd() - 0.5) * 0.14;
    }
  }
  return arr;
}

function blob(rnd: Rnd) {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const phi = Math.acos(1 - 2 * rnd());
    const theta = rnd() * Math.PI * 2;
    const r =
      1.55 *
      (1 +
        0.32 * Math.sin(3 * theta) * Math.sin(2 * phi) +
        0.18 * Math.sin(5 * phi + 2 * theta) +
        0.12 * Math.cos(4 * theta));
    arr[i * 3] = Math.sin(phi) * Math.cos(theta) * r;
    arr[i * 3 + 1] = Math.cos(phi) * r;
    arr[i * 3 + 2] = Math.sin(phi) * Math.sin(theta) * r;
  }
  return arr;
}

function coin(rnd: Rnd) {
  const arr = new Float32Array(PARTICLE_COUNT * 3);
  const R = 2.1;
  const h = 0.17;
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const a = rnd() * Math.PI * 2;
    if (rnd() < 0.62) {
      const r = R * Math.sqrt(rnd());
      arr[i * 3] = Math.cos(a) * r;
      arr[i * 3 + 1] = Math.sin(a) * r;
      arr[i * 3 + 2] = rnd() < 0.5 ? h : -h;
    } else {
      arr[i * 3] = Math.cos(a) * R;
      arr[i * 3 + 1] = Math.sin(a) * R;
      arr[i * 3 + 2] = (rnd() - 0.5) * 2 * h;
    }
  }
  rotateX(arr, 1.0);
  rotateY(arr, 0.5);
  return arr;
}

/** Deterministic per-particle seeds used by the shader for twinkle and drift. */
export function buildSeeds(): Float32Array {
  const rnd = mulberry32(4242);
  const seeds = new Float32Array(PARTICLE_COUNT);
  for (let i = 0; i < PARTICLE_COUNT; i++) seeds[i] = rnd();
  return seeds;
}

export function buildTargets(): Float32Array[] {
  const rnd = mulberry32(1337);
  return [
    lattice(rnd),
    disc(rnd),
    sphere(rnd),
    ring(rnd),
    stream(rnd),
    blob(rnd),
    coin(rnd),
  ];
}
