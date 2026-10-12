"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { useTexture } from "@react-three/drei";
import { Suspense, useMemo, useRef } from "react";
import * as THREE from "three";
import { beginDrag, catInput, decayDrag, endDrag, moveDrag, petState } from "@/lib/petStore";
import { MAX_DOMES, MAX_EYES, MAX_FLAPS, rigFor, type FormRig } from "@/lib/petForms";

// A pet render brought to life as a depth-displaced plane. The rig (src/lib/petForms.ts)
// lists the picture's volumes (depth), eyes (blinking lids), flaps (parts that rotate
// about a pivot: ears, tails, spikes, rings), a breathing region, a head tilt, a
// whole-picture rock and a region whose glow pulses. Everything is driven from the
// frame loop; the viewer can drag to orbit and gate clicks trigger a burst.

const vertexShader = /* glsl */ `
  uniform float uDepthAmt, uBreath, uTilt, uRock, uBurst, uTime;
  uniform vec4 uDomes[${MAX_DOMES}];
  uniform float uDomeH[${MAX_DOMES}];
  uniform int uDomeN;
  uniform vec4 uFlaps[${MAX_FLAPS}];
  uniform vec2 uFlapPivot[${MAX_FLAPS}];
  uniform float uFlapAngle[${MAX_FLAPS}];
  uniform int uFlapN;
  uniform vec4 uBreathE, uTiltE;
  uniform vec2 uTiltPivot;
  varying vec2 vUv;

  float ell(vec2 p, vec4 e) { vec2 d = (p - e.xy) / e.zw; return dot(d, d); }
  float dome(vec2 p, vec4 e) { float q = ell(p, e); return q < 1.0 ? sqrt(1.0 - q) : 0.0; }
  vec2 rot(vec2 p, vec2 c, float a) {
    vec2 d = p - c; float s = sin(a), co = cos(a);
    return c + vec2(d.x * co - d.y * s, d.x * s + d.y * co);
  }

  void main() {
    vec2 w = uv;
    for (int i = 0; i < ${MAX_FLAPS}; i++) {
      if (i >= uFlapN) break;
      float wf = smoothstep(1.0, 0.35, ell(uv, uFlaps[i]));
      w = mix(w, rot(w, uFlapPivot[i], uFlapAngle[i]), wf);
    }
    if (uTiltE.z > 0.0) {
      float wh = smoothstep(1.0, 0.55, ell(uv, uTiltE));
      w = mix(w, rot(w, uTiltPivot, uTilt), wh);
    }
    if (uBreathE.z > 0.0) {
      float wb = smoothstep(1.0, 0.45, ell(uv, uBreathE));
      w = mix(w, uBreathE.xy + (w - uBreathE.xy) * (1.0 + uBreath), wb);
    }
    w = rot(w, vec2(0.5, 0.5), uRock);

    float d = 0.0;
    for (int i = 0; i < ${MAX_DOMES}; i++) {
      if (i >= uDomeN) break;
      d = max(d, uDomeH[i] * dome(uv, uDomes[i]));
    }
    float jitter = uBurst * uBurst * 0.011 * sin(uv.y * 46.0 + uTime * 50.0);
    vec3 pos = vec3(w - 0.5 + vec2(jitter, 0.0), d * uDepthAmt * (1.0 + uBurst * 0.9));

    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uBlink, uAberr, uGlow, uDebug, uPulse;
  uniform vec3 uTint;
  uniform vec4 uEyes[${MAX_EYES}];
  uniform int uEyeN;
  uniform vec4 uPulseE, uBreathE;
  uniform vec4 uDomes[${MAX_DOMES}];
  uniform int uDomeN;
  uniform vec4 uFlaps[${MAX_FLAPS}];
  uniform int uFlapN;
  varying vec2 vUv;

  float ell(vec2 p, vec4 e) { vec2 d = (p - e.xy) / e.zw; return dot(d, d); }

  vec2 lid(vec2 uv, vec4 e) {
    vec2 d = (uv - e.xy) / e.zw;
    if (dot(d, d) < 1.0) {
      float open = 1.0 - uBlink;
      if (abs(d.y) > open) {
        // eyelid: cover the eye with skin sampled just above or below it
        return e.xy + vec2(d.x, sign(d.y) * 1.3) * e.zw;
      }
    }
    return uv;
  }

  vec3 sampleRGB(vec2 uv) {
    if (uAberr > 0.0001) {
      return vec3(
        texture2D(uMap, uv + vec2(uAberr, 0.0)).r,
        texture2D(uMap, uv).g,
        texture2D(uMap, uv - vec2(uAberr, 0.0)).b
      );
    }
    return texture2D(uMap, uv).rgb;
  }

  void main() {
    vec2 uv = vUv;
    for (int i = 0; i < ${MAX_EYES}; i++) {
      if (i >= uEyeN) break;
      uv = lid(uv, uEyes[i]);
    }
    vec3 base = sampleRGB(uv);
    float lum = max(max(base.r, base.g), base.b);
    float alpha = smoothstep(0.015, 0.12, lum);
    float pulse = 0.0;
    if (uPulseE.z > 0.0) pulse = uPulse * smoothstep(1.0, 0.3, ell(vUv, uPulseE));
    vec3 col = base * uTint * (1.0 + uGlow + pulse);
    if (uDebug > 0.5) {
      alpha = 1.0;
      for (int i = 0; i < ${MAX_DOMES}; i++) { if (i >= uDomeN) break; if (ell(vUv, uDomes[i]) < 1.0) col += vec3(0.18, 0.0, 0.0); }
      if (uBreathE.z > 0.0 && ell(vUv, uBreathE) < 1.0) col += vec3(0.0, 0.18, 0.0);
      for (int i = 0; i < ${MAX_FLAPS}; i++) { if (i >= uFlapN) break; if (ell(vUv, uFlaps[i]) < 1.0) col += vec3(0.0, 0.0, 0.35); }
      for (int i = 0; i < ${MAX_EYES}; i++) { if (i >= uEyeN) break; if (ell(vUv, uEyes[i]) < 1.0) col += vec3(0.4, 0.0, 0.4); }
      if (uPulseE.z > 0.0 && ell(vUv, uPulseE) < 1.0) col += vec3(0.2, 0.2, 0.0);
    }
    gl_FragColor = vec4(col * alpha, alpha);
  }
`;

function configureTexture(tex: THREE.Texture | THREE.Texture[]) {
  const list = Array.isArray(tex) ? tex : [tex];
  for (const t of list) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    t.needsUpdate = true;
  }
}

const v4 = (e: [number, number, number, number] | undefined) => new THREE.Vector4(...(e ?? [0, 0, 0, 0]));
const pad = <T,>(items: T[], n: number, fill: () => T): T[] =>
  Array.from({ length: n }, (_, i) => (i < items.length ? items[i] : fill()));

function Picture({ rig, debug, tint }: { rig: FormRig; debug: boolean; tint: string }) {
  const map = useTexture(`/characters/${rig.file}`, configureTexture);
  const mesh = useRef<THREE.Mesh>(null);
  const mat = useRef<THREE.ShaderMaterial>(null);
  const timing = useRef({ nextBlink: 1.8, blinkStart: -10, nextFlick: 2.5, flickStart: -10, flickIndex: 0 });

  const uniforms = useMemo(
    () => ({
      uMap: { value: map },
      uTime: { value: 0 },
      uDepthAmt: { value: rig.depth },
      uBreath: { value: 0 },
      uTilt: { value: 0 },
      uRock: { value: 0 },
      uBurst: { value: 0 },
      uBlink: { value: 0 },
      uAberr: { value: 0 },
      uGlow: { value: 0 },
      uPulse: { value: 0 },
      uDebug: { value: debug ? 1 : 0 },
      uTint: { value: new THREE.Color(1, 1, 1) },
      uDomes: { value: pad(rig.domes.map((d) => v4(d.e)), MAX_DOMES, () => v4(undefined)) },
      uDomeH: { value: pad(rig.domes.map((d) => d.h), MAX_DOMES, () => 0) },
      uDomeN: { value: Math.min(rig.domes.length, MAX_DOMES) },
      uFlaps: { value: pad(rig.flaps.map((f) => v4(f.e)), MAX_FLAPS, () => v4(undefined)) },
      uFlapPivot: { value: pad(rig.flaps.map((f) => new THREE.Vector2(...f.pivot)), MAX_FLAPS, () => new THREE.Vector2()) },
      uFlapAngle: { value: pad([] as number[], MAX_FLAPS, () => 0) },
      uFlapN: { value: Math.min(rig.flaps.length, MAX_FLAPS) },
      uEyes: { value: pad(rig.eyes.map((e) => v4(e)), MAX_EYES, () => v4(undefined)) },
      uEyeN: { value: Math.min(rig.eyes.length, MAX_EYES) },
      uBreathE: { value: v4(rig.breath?.e) },
      uTiltE: { value: v4(rig.tilt?.e) },
      uTiltPivot: { value: new THREE.Vector2(...(rig.tilt?.pivot ?? [0.5, 0.5])) },
      uPulseE: { value: v4(rig.pulse?.e) },
    }),
    [map, debug, rig],
  );

  const tintColor = useMemo(() => new THREE.Color(tint), [tint]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const m = mesh.current;
    const u = mat.current?.uniforms;
    if (!m || !u) return;

    const since = (Date.now() - petState.burstAt) / 1000;
    const burst = petState.burstAt > 0 && since < 0.7 ? 1 - since / 0.7 : 0;
    const tm = timing.current;

    // blink
    if (rig.eyes.length > 0 && t > tm.nextBlink) {
      tm.blinkStart = t;
      tm.nextBlink = t + 2.6 + Math.random() * 3.4;
    }
    const b = (t - tm.blinkStart) / 0.22;
    const blink = b >= 0 && b <= 1 ? Math.sin(b * Math.PI) : 0;

    // one flap flicks now and then
    const flickers = rig.flaps.map((f, i) => (f.flick ? i : -1)).filter((i) => i >= 0);
    if (flickers.length > 0 && t > tm.nextFlick) {
      tm.flickStart = t;
      tm.flickIndex = flickers[Math.floor(Math.random() * flickers.length)];
      tm.nextFlick = t + 3 + Math.random() * 4;
    }
    const fk = (t - tm.flickStart) / 0.32;
    const flick = fk >= 0 && fk <= 1 ? Math.sin(fk * Math.PI) : 0;
    const burstWiggle = burst * 0.12 * Math.sin(since * 55);

    const angles = u.uFlapAngle.value as number[];
    rig.flaps.forEach((f, i) => {
      if (i >= MAX_FLAPS) return;
      const side = i % 2 === 0 ? -1 : 1;
      const flickHere = tm.flickIndex === i ? side * -0.22 * flick : 0;
      angles[i] = f.amp * Math.sin(t * f.speed + f.phase) + flickHere + burstWiggle * side;
    });

    u.uTime.value = t;
    (u.uTint.value as THREE.Color).lerp(tintColor, 0.06);
    u.uBreath.value = rig.breath ? rig.breath.amp * Math.sin(t * 2.0) + burst * 0.03 : 0;
    u.uTilt.value = rig.tilt ? rig.tilt.amp * Math.sin(t * rig.tilt.speed) + burst * 0.05 * Math.sin(since * 40) : 0;
    u.uRock.value = rig.rock.amp * Math.sin(t * rig.rock.speed) + burst * 0.04 * Math.sin(since * 45);
    u.uPulse.value = rig.pulse ? rig.pulse.amp * (0.5 + 0.5 * Math.sin(t * rig.pulse.speed)) : 0;
    u.uBlink.value = blink;
    u.uBurst.value = burst;
    u.uAberr.value = 0.006 * burst;
    u.uGlow.value = 0.5 * burst + 0.04 * Math.sin(t * 3.0);

    const idleY = 0.28 * Math.sin(t * 0.35);
    const idleX = 0.07 * Math.sin(t * 0.5) + 0.03;
    const targetY = catInput.dragging ? catInput.x : idleY + catInput.x * 0.6;
    const targetX = catInput.dragging ? catInput.y : idleX + catInput.y * 0.6;
    m.rotation.y += (THREE.MathUtils.clamp(targetY, -0.55, 0.55) - m.rotation.y) * 0.08;
    m.rotation.x += (THREE.MathUtils.clamp(targetX, -0.25, 0.25) - m.rotation.x) * 0.08;
    decayDrag();
    m.position.y = 0.012 * Math.sin(t * 1.4);
    const s = 1.58 * (1 + burst * 0.03);
    m.scale.set(s, s, 1);
  });

  return (
    <mesh ref={mesh}>
      <planeGeometry args={[1, 1, 220, 220]} />
      <shaderMaterial
        ref={mat}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        transparent
        depthWrite={false}
        blending={THREE.CustomBlending}
        blendSrc={THREE.OneFactor}
        blendDst={THREE.OneMinusSrcAlphaFactor}
        blendSrcAlpha={THREE.OneFactor}
        blendDstAlpha={THREE.OneMinusSrcAlphaFactor}
      />
    </mesh>
  );
}

/**
 * A pet form as a living picture. `form` picks the rig (forms without art borrow
 * the cat); `tint` is a CSS hex colour multiplied into the picture.
 */
export default function DepthCreature({
  form = "cat",
  debug = false,
  tint = "#ffffff",
}: {
  form?: string;
  debug?: boolean;
  tint?: string;
}) {
  const last = useRef<{ x: number; y: number } | null>(null);
  const { rig } = rigFor(form);

  return (
    <div
      className="h-full w-full cursor-grab select-none active:cursor-grabbing"
      style={{ touchAction: "pan-y" }}
      onPointerDown={(e) => {
        beginDrag();
        last.current = { x: e.clientX, y: e.clientY };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!last.current) return;
        moveDrag(e.clientX - last.current.x, e.clientY - last.current.y);
        last.current = { x: e.clientX, y: e.clientY };
      }}
      onPointerUp={() => {
        endDrag();
        last.current = null;
      }}
      onPointerCancel={() => {
        endDrag();
        last.current = null;
      }}
    >
      <Canvas dpr={[1, 1.5]} camera={{ position: [0, 0, 2.6], fov: 38 }} gl={{ alpha: true, antialias: true }}>
        <Suspense fallback={null}>
          <Picture key={rig.file} rig={rig} debug={debug} tint={tint} />
        </Suspense>
      </Canvas>
    </div>
  );
}
