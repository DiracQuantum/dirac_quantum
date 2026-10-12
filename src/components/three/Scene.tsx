"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { Bloom, EffectComposer, Vignette } from "@react-three/postprocessing";
import { driveBloom, registerBloom } from "@/lib/bloomStore";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { startIntro } from "@/lib/introStore";
import { motionReduced } from "@/lib/motion";
import { scrollState } from "@/lib/scrollStore";
import { buildSeeds, buildTargets, SCENE_COUNT } from "./targets";

const vertexShader = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uSize;
  uniform float uPixelRatio;
  uniform float uVary;
  varying float vSeed;
  varying float vY;
  void main() {
    vec3 p = position;
    p += 0.035 * vec3(
      sin(uTime * 1.3 + aSeed * 6.283),
      cos(uTime * 1.1 + aSeed * 3.1),
      sin(uTime * 0.9 + aSeed * 9.4)
    );
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float twinkle = 0.75 + 0.35 * sin(aSeed * 40.0 + uTime * 2.0);
    // while the cloud is loose every particle keeps its own size: sparks, not a wash
    float spark = mix(1.0, 0.3 + 1.7 * fract(aSeed * 7.31), uVary);
    gl_PointSize = uSize * uPixelRatio * twinkle * spark * (6.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
    vSeed = aSeed;
    vY = p.y;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uAlpha;
  varying float vSeed;
  varying float vY;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float core = smoothstep(0.5, 0.0, d);
    float alpha = core * core;
    float mixv = clamp(vY * 0.22 + 0.5 + (vSeed - 0.5) * 0.3, 0.0, 1.0);
    vec3 col = mix(uColorA, uColorB, mixv);
    gl_FragColor = vec4(col * (0.8 + 0.6 * core), alpha * uAlpha);
  }
`;

/** Page-load burst timeline, seconds: implosion, detonation, settling. The hero text waits for it. */
const INTRO_IMPLODE = 0.7;
const INTRO_BURST = 0.5;
const INTRO_SETTLE = 1.5;
const INTRO_SECONDS = INTRO_IMPLODE + INTRO_BURST + INTRO_SETTLE;

const COLOR_A = new THREE.Color("#d9e4f7");
const COLOR_B = new THREE.Color("#5f8fe8");
const HOT_A = new THREE.Color("#ffffff");
const HOT_B = new THREE.Color("#dbe8ff");

const easeInOutCubic = (x: number) =>
  x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;

// Per-section horizontal offset (world units), scale and particle opacity on wide screens.
// Formations sit centred behind the card of each section (its [data-scene-anchor]),
// never behind the reading column: the radar, the sphere and the seal ring are a
// little wider than their card and frame it evenly on both sides; the inbox stream
// and the coin hide behind theirs; the playground blob fills the empty space right
// of the chapter title and then tucks behind the arena card. X_OFFSETS is the
// fallback for a section without an anchor (the hero) and before the first measure.
const X_OFFSETS = [3.2, 2.6, 2.7, 2.7, 2.5, 3.4, 2.6];
const SCALES = [0.78, 1.1, 0.95, 0.9, 0.6, 0.75, 0.85];
const ALPHAS = [0.6, 0.45, 0.45, 0.45, 0.4, 0.5, 0.4];
/**
 * Narrow screens stack the columns, so text runs over the whole width: a small
 * formation by the right edge, kept faint. Shrinking a formation packs its
 * particles tighter and the additive blend turns that into a glare, so the
 * points are smaller here too.
 */
const NARROW_X = 1.1;
const NARROW_SCALE = 0.5;
const NARROW_ALPHA = 0.2;
const NARROW_SIZE = 14;
/** Live per-section x of each chapter's card in world units, refreshed every frame. */
const anchorX = [...X_OFFSETS];

function sample(arr: number[], t: number) {
  const i = Math.min(Math.floor(t), arr.length - 2);
  const f = THREE.MathUtils.clamp(t - i, 0, 1);
  return arr[i] + (arr[i + 1] - arr[i]) * f;
}

/** Derives a continuous "scene index" from which [data-scene] section is centred in the viewport. */
function SceneTracker() {
  const els = useRef<HTMLElement[]>([]);
  const anchors = useRef<(HTMLElement | null)[]>([]);
  const frame = useRef(0);

  useFrame((state, dt) => {
    frame.current++;
    // re-query periodically, and at once after a client-side navigation detached the old sections
    if (els.current.length === 0 || frame.current % 120 === 0 || !els.current[0].isConnected) {
      els.current = Array.from(
        document.querySelectorAll<HTMLElement>("[data-scene]"),
      ).sort((a, b) => Number(a.dataset.scene) - Number(b.dataset.scene));
      anchors.current = els.current.map((el) => el.querySelector<HTMLElement>("[data-scene-anchor]"));
    }
    const list = els.current;
    if (!list.length) {
      // app pages have no chapters: back to the lattice (whatever chapter the
      // visitor left the landing page on), kept as a quiet backdrop
      scrollState.sceneT += (0 - scrollState.sceneT) * Math.min(1, dt * 3.5);
      // a quiet 0.6 while reading, fading out completely as the footer comes up,
      // so the lattice never lies across the footer links
      const foot = document.querySelector("footer");
      const vhApp = window.innerHeight;
      const rise = foot
        ? THREE.MathUtils.clamp((vhApp - foot.getBoundingClientRect().top) / (vhApp * 0.5), 0, 1)
        : 0;
      const quietTail = 0.6 + 0.4 * rise;
      scrollState.tail += (quietTail - scrollState.tail) * Math.min(1, dt * 4);
      return;
    }

    // where each chapter's card sits horizontally, in world units at the formation's depth
    const cam = state.camera as THREE.PerspectiveCamera;
    const halfW =
      Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.position.z * (state.size.width / state.size.height);
    for (let i = 0; i < list.length; i++) {
      const a = anchors.current[i];
      const k = Number(list[i].dataset.scene);
      if (!a || !(k >= 0 && k < anchorX.length)) continue;
      const r = a.getBoundingClientRect();
      if (r.width > 0) anchorX[k] = (((r.left + r.width / 2) / state.size.width) * 2 - 1) * halfW;
    }

    const vh = window.innerHeight;
    let t = 0;
    let prev = 0;
    let tail = 0;
    for (let i = 0; i < list.length; i++) {
      const r = list[i].getBoundingClientRect();
      const c = r.top + r.height / 2 - vh * 0.5;
      if (i === 0 && c >= 0) {
        t = 0;
        break;
      }
      if (c >= 0) {
        t = i - 1 + -prev / (c - prev);
        break;
      }
      prev = c;
      t = i;
      if (i === list.length - 1) {
        // past the centre of the last section: fade the formation out, done by the
        // time the footer reaches mid-screen so it never crosses the footer title
        tail = THREE.MathUtils.clamp(-c / (vh * 0.35), 0, 1);
      }
    }
    t = THREE.MathUtils.clamp(t, 0, SCENE_COUNT - 1);
    scrollState.sceneT += (t - scrollState.sceneT) * Math.min(1, dt * 3.5);
    scrollState.tail += (tail - scrollState.tail) * Math.min(1, dt * 4);
  });

  return null;
}

function Particles() {
  const targets = useMemo(() => buildTargets(), []);
  const positions = useMemo(() => new Float32Array(targets[0]), [targets]);
  const seeds = useMemo(() => buildSeeds(), []);
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uSize: { value: 30 },
      uPixelRatio: { value: 1 },
      uAlpha: { value: 0 },
      uVary: { value: 1 },
      uColorA: { value: new THREE.Color("#d9e4f7") },
      uColorB: { value: new THREE.Color("#5f8fe8") },
    }),
    [],
  );
  const posRef = useRef<THREE.BufferAttribute>(null);
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const frames = useRef(0);
  // the burst runs on the scene clock, started on its second frame; the shared
  // intro clock is started at the same moment, so the flash and the hero text
  // follow it unless the fallback timer already fired (then only the particles play)
  const start = useRef(-1);
  // reduced motion: no burst, the lattice is simply there
  const [reduced] = useState(motionReduced);

  useFrame((state, dt) => {
    const attr = posRef.current;
    const mat = matRef.current;
    if (!attr || !mat) return;

    // The shared intro clock starts on the second frame: the first one compiles
    // the shaders and would swallow the start of the burst. The CSS flash and
    // the hero text wait for the same signal.
    frames.current += 1;
    if (frames.current === 2) {
      start.current = performance.now();
      startIntro();
    }
    if (reduced) startIntro();

    const t = scrollState.sceneT;
    const wide = window.innerWidth >= 1024;
    // Page-load burst in three phases: particles rush in from the dark and
    // collapse into one white-hot point (implosion), the point detonates and
    // everything flies outward with a twist and overshoot (burst), then the
    // cloud slows and settles into the lattice (settle).
    const te = reduced ? INTRO_SECONDS : start.current < 0 ? 0 : (performance.now() - start.current) / 1000;
    const intro = THREE.MathUtils.clamp(te / INTRO_SECONDS, 0, 1);
    let scale = 1;
    let vary = 0; // how much per-particle radius variation is still present
    let sizeMul = 1;
    let hot = 0; // 0 = normal palette, 1 = white-hot
    let alphaBoost = 0;
    if (te < INTRO_IMPLODE) {
      const p = te / INTRO_IMPLODE;
      const e = Math.pow(p, 2.2);
      scale = 2.6 - (2.6 - 0.03) * e;
      vary = 1;
      sizeMul = 0.7 + 0.3 * e;
      hot = 0.7 * e;
      alphaBoost = 0.25 + 0.3 * e;
    } else if (te < INTRO_IMPLODE + INTRO_BURST) {
      const p = (te - INTRO_IMPLODE) / INTRO_BURST;
      const e = 1 - Math.pow(1 - p, 3);
      scale = 0.03 + (2.5 - 0.03) * e;
      vary = 1;
      sizeMul = 1 + 2.6 * (1 - p);
      hot = 1 - 0.4 * p;
      alphaBoost = 0.8 * (1 - p) + 0.25;
    } else if (te < INTRO_SECONDS) {
      const p = (te - INTRO_IMPLODE - INTRO_BURST) / INTRO_SETTLE;
      const e = easeInOutCubic(p);
      scale = 2.5 - 1.5 * e;
      vary = 1 - e;
      sizeMul = 1 + 0.4 * (1 - e);
      hot = 0.6 * (1 - e);
      alphaBoost = 0.25 * (1 - e);
    }
    scrollState.intro = intro;
    scrollState.introHot = hot;

    const targetAlpha = (wide ? sample(ALPHAS, t) : NARROW_ALPHA) * (1 - scrollState.tail) + alphaBoost;
    mat.uniforms.uSize.value = (wide ? 30 : NARROW_SIZE) * sizeMul;
    mat.uniforms.uVary.value = vary;
    // same easing as 0.35 / 0.05 per frame at 60 fps, independent of the frame rate
    const ease = 1 - Math.pow(intro < 1 ? 0.65 : 0.95, Math.min(dt, 0.1) * 60);
    mat.uniforms.uAlpha.value += (targetAlpha - mat.uniforms.uAlpha.value) * ease;
    (mat.uniforms.uColorA.value as THREE.Color).lerpColors(COLOR_A, HOT_A, hot);
    (mat.uniforms.uColorB.value as THREE.Color).lerpColors(COLOR_B, HOT_B, hot);

    const i = Math.min(Math.floor(t), SCENE_COUNT - 2);
    const f = easeInOutCubic(THREE.MathUtils.clamp(t - i, 0, 1));
    const a = targets[i];
    const b = targets[i + 1];
    const arr = attr.array as Float32Array;
    if (intro < 1) {
      for (let p = 0; p < seeds.length; p++) {
        // each particle keeps its own radius multiplier while the cloud is loose,
        // so the burst is a sphere of debris rather than a scaled lattice
        const s = scale * (1 + (seeds[p] - 0.5) * 0.9 * vary);
        const k = p * 3;
        arr[k] = (a[k] + (b[k] - a[k]) * f) * s;
        arr[k + 1] = (a[k + 1] + (b[k + 1] - a[k + 1]) * f) * s;
        arr[k + 2] = (a[k + 2] + (b[k + 2] - a[k + 2]) * f) * s;
      }
    } else {
      for (let k = 0; k < arr.length; k++) arr[k] = a[k] + (b[k] - a[k]) * f;
    }
    attr.needsUpdate = true;

    mat.uniforms.uTime.value = state.clock.elapsedTime;
    mat.uniforms.uPixelRatio.value = state.gl.getPixelRatio();
  });

  return (
    <points>
      <bufferGeometry>
        <bufferAttribute
          ref={posRef}
          attach="attributes-position"
          args={[positions, 3]}
        />
        <bufferAttribute attach="attributes-aSeed" args={[seeds, 1]} />
      </bufferGeometry>
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

function Bloch() {
  const mesh = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.MeshBasicMaterial>(null);
  const arrow = useRef<THREE.ArrowHelper>(null);
  const dir = useMemo(() => new THREE.Vector3(0, 1, 0), []);
  const origin = useMemo(() => new THREE.Vector3(0, 0, 0), []);

  useEffect(() => {
    const a = arrow.current;
    if (!a) return;
    (a.line.material as THREE.Material).transparent = true;
    (a.cone.material as THREE.Material).transparent = true;
  }, []);

  useFrame((state) => {
    const t = scrollState.sceneT;
    // visible around the hero (t near 0) and the passport section (t near 2)
    const vis = Math.max(1 - t / 0.7, 1 - Math.abs(t - 2) / 0.6);
    // fades with the particles over the footer and on app pages (tail), where the
    // lattice is only a quiet backdrop and the bright arrow would compete with the content
    const quiet = 1 - scrollState.tail;
    const op = THREE.MathUtils.clamp(vis, 0, 1) * quiet * quiet;
    if (mat.current) mat.current.opacity = op * 0.12;
    if (mesh.current) mesh.current.visible = op > 0.01;

    const el = state.clock.elapsedTime;
    dir
      .set(
        Math.sin(el * 0.7) * 0.8,
        Math.cos(el * 0.5) * 0.6 + 0.2,
        Math.sin(el * 0.9) * 0.5,
      )
      .normalize();
    const a = arrow.current;
    if (a) {
      a.setDirection(dir);
      a.visible = op > 0.01;
      (a.line.material as THREE.Material).opacity = op * 0.9;
      (a.cone.material as THREE.Material).opacity = op * 0.9;
    }
  });

  return (
    <>
      <mesh ref={mesh}>
        <sphereGeometry args={[2.35, 28, 18]} />
        <meshBasicMaterial
          ref={mat}
          wireframe
          color="#8fa6cf"
          transparent
          opacity={0.12}
          depthWrite={false}
        />
      </mesh>
      <arrowHelper
        ref={arrow}
        args={[dir, origin, 2.35, "#4d8bff", 0.35, 0.18]}
      />
    </>
  );
}

function Rig({ children }: { children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null);
  const mouse = useRef({ x: 0, y: 0 });
  const base = useRef(0);

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      mouse.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      mouse.current.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  useFrame((_, dt) => {
    const g = group.current;
    if (!g) return;
    base.current += dt * 0.06;

    // during the page-load burst the whole cloud unwinds from a twist
    const introEase = 1 - Math.pow(1 - scrollState.intro, 3);
    const spin = (1 - introEase) * 2.8;
    const follow = scrollState.intro < 1 ? 0.2 : 0.04;
    const targetX = mouse.current.y * 0.18 + (1 - introEase) * 0.5;
    const targetY = base.current + mouse.current.x * 0.25 + spin;
    g.rotation.x += (targetX - g.rotation.x) * follow;
    g.rotation.y += (targetY - g.rotation.y) * follow;

    // matches the lg breakpoint where sections switch to two columns
    const wide = window.innerWidth >= 1024;
    // narrow screens: a smaller, quieter formation tucked towards the right edge
    const tx = wide ? sample(anchorX, scrollState.sceneT) : NARROW_X;
    const s = wide ? sample(SCALES, scrollState.sceneT) : NARROW_SCALE;
    g.position.x += (tx - g.position.x) * 0.05;
    const ns = g.scale.x + (s - g.scale.x) * 0.05;
    g.scale.setScalar(ns);

    const vy = THREE.MathUtils.clamp(scrollState.velocity * 0.004, -0.6, 0.6);
    g.position.y += (-vy - g.position.y) * 0.08;
  });

  return <group ref={group}>{children}</group>;
}

/** Cheap heuristic for weak GPUs and phones: skip post-processing and render at 1x. */
function detectLowPower() {
  if (typeof navigator === "undefined") return false;
  const cores = navigator.hardwareConcurrency ?? 8;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  return cores <= 4 || mobile;
}

/** Pushes the bloom up while the page-load burst is white-hot, then relaxes it. */
function BloomDriver() {
  useFrame(() => driveBloom(scrollState.introHot));
  return null;
}

export default function Scene() {
  const [lowPower] = useState(detectLowPower);

  return (
    <div className="pointer-events-none fixed inset-0 z-0" aria-hidden>
      <Canvas
        dpr={lowPower ? 1 : [1, 1.5]}
        camera={{ position: [0, 0, 9], fov: 42 }}
        gl={{ antialias: false, powerPreference: "high-performance" }}
      >
        <color attach="background" args={["#070708"]} />
        <SceneTracker />
        <Rig>
          <Particles />
          <Bloch />
        </Rig>
        {lowPower ? null : (
          <>
            <BloomDriver />
            <EffectComposer multisampling={0}>
              <Bloom
                ref={registerBloom}
                intensity={0.75}
                luminanceThreshold={0.2}
                luminanceSmoothing={0.4}
                mipmapBlur
              />
              <Vignette eskil={false} offset={0.15} darkness={0.75} />
            </EffectComposer>
          </>
        )}
      </Canvas>
    </div>
  );
}
