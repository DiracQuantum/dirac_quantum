"use client";

/**
 * A real 3D body for the Quantum Pet, from a GLB (Meshy image-to-3D export).
 *
 * Two kinds of model are handled, detected from what the file carries:
 * - a bare mesh (no UVs, no material): drawn as a dark quantum solid with a
 *   rim of light in the palette of the day, an energy band rolling up the
 *   body and a skin of tiny particles, exactly as before;
 * - a textured mesh (UVs + a PBR material with a baseColor texture, or vertex
 *   colours): the model exactly as it was made, its texture a little brighter
 *   and more contrasted so the constellation reads as light. Nothing is drawn
 *   over it: no rim, band, particles or halo (the owner's call, 2026-10-11).
 * Both get a swarm of sparks on slow elliptical orbits around the body.
 * The body turns by itself, can be dragged all the way round, breathes and
 * reacts to gates with a swell.
 *
 * Testing: /pet?model=/models/test-textured.glb overrides the form's model
 * (paths under /models on this origin only, see PetBody) and ?yaw=<radians> overrides the
 * form's `modelYaw` so the right value can be found before it goes into
 * src/lib/petForms.ts. scripts/make-test-glb.ts writes the test asset.
 */

import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import { Component, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { beginDrag, catInput, decayDrag, endDrag, moveDrag, petState } from "@/lib/petStore";

/* ------------------------------------------------------------------ */
/* Body                                                                */
/* ------------------------------------------------------------------ */

// HAS_MAP / HAS_VCOLOR / HAS_ALBEDO are set through material.defines; without
// them the shader compiles to the original bare-mesh look.
const bodyVert = /* glsl */ `
  uniform float uTime;
  uniform float uBurst;
  // the model's half height over the original cat's (0.95): every displacement
  // below was tuned on that cat, Meshy exports come at any scale
  uniform float uUnit;
  varying vec3 vN;
  varying vec3 vP;
  varying vec3 vV;
  #ifdef HAS_MAP
  uniform mat3 uMapTransform;
  varying vec2 vUv;
  #endif
  #ifdef HAS_VCOLOR
  varying vec3 vColor;
  #endif
  void main() {
    vec3 p = position;
    float y = p.y / uUnit;
    // slow jelly sway so a single rigid mesh still reads as alive
    float lift = 0.5 + 0.5 * y;
    p.x += sin(uTime * 1.3 + y * 2.2) * 0.012 * lift * uUnit;
    p.z += cos(uTime * 1.1 + y * 1.7) * 0.008 * lift * uUnit;
    // gate burst: the surface swells in ripples
    p += normal * uBurst * 0.05 * (0.5 + 0.5 * sin(y * 9.0 + uTime * 7.0)) * uUnit;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vN = normalize(normalMatrix * normal);
    vP = p / uUnit;
    vV = -mv.xyz;
    #ifdef HAS_MAP
    vUv = (uMapTransform * vec3(uv, 1.0)).xy;
    #endif
    #ifdef HAS_VCOLOR
    vColor = color.rgb;
    #endif
    gl_Position = projectionMatrix * mv;
  }
`;

const bodyFrag = /* glsl */ `
  uniform float uTime;
  uniform float uBurst;
  uniform vec3 uTint;
  varying vec3 vN;
  varying vec3 vP;
  varying vec3 vV;
  #ifdef HAS_ALBEDO
  uniform vec3 uBaseColor;
  // the textured look: contrast around mid grey, a lift in brightness, saturation
  #define TEX_CONTRAST 1.3
  #define TEX_BRIGHTNESS 0.06
  #define TEX_SATURATION 1.15
  #endif
  #ifdef HAS_MAP
  uniform sampler2D uMap;
  varying vec2 vUv;
  #endif
  #ifdef HAS_VCOLOR
  varying vec3 vColor;
  #endif

  void main() {
    vec3 n = normalize(vN);
    vec3 v = normalize(vV);
    float ndv = clamp(dot(n, v), 0.0, 1.0);
    float rim = pow(1.0 - ndv, 2.4);
    vec3 key = normalize(vec3(0.6, 0.9, 0.8));
    vec3 fill = normalize(vec3(-0.7, -0.3, 0.4));
    float lk = max(dot(n, key), 0.0);
    float lf = max(dot(n, fill), 0.0);
    // a soft glow from below in the day's colour, as if it sat on its own light
    float under = max(-n.y, 0.0);
    // an energy band rolling up the body
    float band = smoothstep(0.10, 0.0, abs(fract(vP.y * 0.45 - uTime * 0.16) - 0.5));
  #ifdef HAS_ALBEDO
    // The texture is sRGB and the GPU decodes it to linear when sampled
    // (texture.colorSpace); three's linearToOutputTexel encodes it back, so
    // these are the picture's own values, adjusted in display space.
    #ifdef HAS_MAP
    vec3 albedoLin = texture2D(uMap, vUv).rgb * uBaseColor;
    #else
    vec3 albedoLin = vColor * uBaseColor;
    #endif
    vec3 albedo = linearToOutputTexel(vec4(max(albedoLin, 0.0), 1.0)).rgb;
    vec3 c = (albedo - 0.5) * TEX_CONTRAST + 0.5 + TEX_BRIGHTNESS;
    c = mix(vec3(dot(c, vec3(0.299, 0.587, 0.114))), c, TEX_SATURATION);
    // a soft key light, just enough for the shape to read in three dimensions
    gl_FragColor = vec4(clamp(c * (0.84 + 0.22 * lk), 0.0, 1.0), 1.0);
  #else
    vec3 base = mix(vec3(0.11, 0.12, 0.17), vec3(0.38, 0.42, 0.52), lk) + uTint * 0.2 * lf;
    vec3 col = base
      + uTint * (rim * 1.4 + under * 0.3 + band * 0.25 + uBurst * 0.5)
      + vec3(1.0) * rim * rim * 0.5;
    gl_FragColor = vec4(col, 1.0);
  #endif
  }
`;

/* ------------------------------------------------------------------ */
/* Skin particles                                                      */
/* ------------------------------------------------------------------ */

const skinVert = /* glsl */ `
  attribute float aSeed;
  uniform float uTime;
  uniform float uBurst;
  uniform float uPixelRatio;
  uniform float uUnit;
  varying float vA;
  void main() {
    vec3 p = position + normal * (0.012 + uBurst * 0.14 * aSeed) * uUnit;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float tw = 0.5 + 0.5 * sin(uTime * 2.2 + aSeed * 40.0);
    gl_PointSize = (1.4 + 2.2 * tw + uBurst * 3.0) * uPixelRatio * (3.2 / -mv.z);
    vA = 0.2 + 0.8 * tw;
    gl_Position = projectionMatrix * mv;
  }
`;

const skinFrag = /* glsl */ `
  uniform vec3 uTint;
  varying float vA;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.0, d);
    gl_FragColor = vec4(mix(vec3(1.0), uTint, 0.45), a * vA);
  }
`;

/* ------------------------------------------------------------------ */
/* Spark swarm                                                         */
/* ------------------------------------------------------------------ */

// Each spark sits on its own ellipse (semi-major axis, axis ratio, angular
// speed, phase) in its own plane (inclination, node, precession rate), rises
// slowly like an ember and fades at the top of its rise, and twinkles.
const swarmVert = /* glsl */ `
  attribute vec4 aOrbit;
  attribute vec3 aPlane;
  attribute vec2 aSeed;
  uniform float uTime;
  uniform float uBurst;
  uniform float uPixelRatio;
  uniform float uRise;
  varying float vA;
  varying float vW;
  void main() {
    float ang = aOrbit.w + uTime * aOrbit.z;
    vec3 q = vec3(cos(ang) * aOrbit.x, 0.0, sin(ang) * aOrbit.x * aOrbit.y);
    float ci = cos(aPlane.x);
    float si = sin(aPlane.x);
    q = vec3(q.x, q.y * ci - q.z * si, q.y * si + q.z * ci);
    float node = aPlane.y + uTime * aPlane.z;
    float cn = cos(node);
    float sn = sin(node);
    q = vec3(q.x * cn + q.z * sn, q.y, -q.x * sn + q.z * cn);
    float life = fract(uTime * 0.045 + aSeed.x);
    q.y += (life - 0.5) * uRise;
    float fade = smoothstep(0.0, 0.2, life) * (1.0 - smoothstep(0.72, 1.0, life));
    q *= 1.0 + uBurst * 0.3;
    vec4 mv = modelViewMatrix * vec4(q, 1.0);
    float tw = 0.5 + 0.5 * sin(uTime * 2.6 + aSeed.x * 37.0);
    tw = tw * tw * tw;
    gl_PointSize = (0.9 + 2.4 * tw + uBurst * 3.0) * aSeed.y * uPixelRatio * (3.2 / -mv.z);
    vA = fade * (0.25 + 0.75 * tw) * (1.0 + uBurst * 1.5);
    vW = tw;
    gl_Position = projectionMatrix * mv;
  }
`;

const swarmFrag = /* glsl */ `
  uniform vec3 uTint;
  varying float vA;
  varying float vW;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float a = smoothstep(0.5, 0.0, d);
    a *= a;
    vec3 col = mix(uTint, vec3(1.0), vW * 0.7);
    gl_FragColor = vec4(col, a * vA);
  }
`;

/* ------------------------------------------------------------------ */
/* Geometry preparation                                                */
/* ------------------------------------------------------------------ */

const TARGET_HEIGHT = 1.9;
/** one skin particle per this many vertices (bare mesh) */
const SKIN_STRIDE = 6;
const SWARM_COUNT = 240;

/** deterministic 0..1 from an index and a salt (no Math.random: safe at render time) */
function hash(i: number, salt: number): number {
  let x = Math.imul(i + 1, 374761393) + Math.imul(salt + 1, 668265263);
  x = Math.imul(x ^ (x >>> 13), 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

type Albedo =
  | { kind: "none" }
  | { kind: "map"; map: THREE.Texture; mapTransform: THREE.Matrix3; baseColor: THREE.Color }
  | { kind: "vcolor"; baseColor: THREE.Color };

/** The part of GLTFLoader's parser that says what the file declares for a material. */
interface GltfParserLike {
  json: { materials?: { pbrMetallicRoughness?: { baseColorTexture?: unknown } }[] };
  associations: Map<THREE.Object3D | THREE.Material | THREE.Texture, { materials?: number }>;
}

interface Prepared {
  body: THREE.BufferGeometry;
  skin: THREE.BufferGeometry;
  swarm: THREE.BufferGeometry;
  /** scale that brings the body to TARGET_HEIGHT */
  base: number;
  /** half the body height in model units */
  halfH: number;
  albedo: Albedo;
}

function firstMesh(scene: THREE.Group): THREE.Mesh | null {
  let found: THREE.Mesh | null = null;
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!found && m.isMesh && m.geometry) found = m;
  });
  return found;
}

/** Whether the glTF material behind `material` declares a baseColor texture (the file, not the loaded result). */
function declaresBaseColorTexture(parser: GltfParserLike, material: THREE.Material): boolean {
  const index = parser.associations.get(material)?.materials;
  if (index === undefined) return false;
  return parser.json.materials?.[index]?.pbrMetallicRoughness?.baseColorTexture !== undefined;
}

/** What the GLB carries: a baseColor texture (needs UVs), vertex colours, or nothing. */
function detectAlbedo(mesh: THREE.Mesh | null, geometry: THREE.BufferGeometry, parser: GltfParserLike): Albedo {
  if (!mesh) return { kind: "none" };
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
    | THREE.MeshStandardMaterial
    | undefined;
  const srcMap = material && "map" in material ? material.map : null;
  // GLTFLoader drops a texture it could not load (map stays null, one console
  // error) and the body would quietly get the bare-mesh look; a textured
  // export must fail loudly instead (ModelBoundary shows it and logs the cause).
  if (material && declaresBaseColorTexture(parser, material) && !srcMap?.image) {
    throw new Error("ModelCreature: the model declares a baseColor texture that did not load (see the GLTFLoader error)");
  }
  const baseColor = new THREE.Color(1, 1, 1);
  if (material && material.color) baseColor.copy(material.color);
  if (srcMap && geometry.attributes.uv) {
    // a clone so the cached loader result stays untouched; the image is shared
    const map = srcMap.clone();
    map.colorSpace = THREE.SRGBColorSpace;
    map.needsUpdate = true;
    if (map.matrixAutoUpdate) map.updateMatrix();
    return { kind: "map", map, mapTransform: map.matrix.clone(), baseColor };
  }
  if (geometry.attributes.color) return { kind: "vcolor", baseColor };
  return { kind: "none" };
}

function makeSkin(body: THREE.BufferGeometry, stride: number): THREE.BufferGeometry {
  const pos = body.attributes.position as THREE.BufferAttribute;
  const nor = body.attributes.normal as THREE.BufferAttribute;
  const n = Math.floor(pos.count / stride);
  const sp = new Float32Array(n * 3);
  const sn = new Float32Array(n * 3);
  const seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const src = i * stride;
    sp[i * 3] = pos.getX(src);
    sp[i * 3 + 1] = pos.getY(src);
    sp[i * 3 + 2] = pos.getZ(src);
    sn[i * 3] = nor.getX(src);
    sn[i * 3 + 1] = nor.getY(src);
    sn[i * 3 + 2] = nor.getZ(src);
    // deterministic pseudo-random per vertex (no Math.random: safe at render time)
    seeds[i] = ((src * 9301 + 49297) % 233280) / 233280;
  }
  const skin = new THREE.BufferGeometry();
  skin.setAttribute("position", new THREE.BufferAttribute(sp, 3));
  skin.setAttribute("normal", new THREE.BufferAttribute(sn, 3));
  skin.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
  return skin;
}

/** Orbits in model units around the body's centre: radii 0.9-1.6 of half the body height. */
function makeSwarm(halfH: number): THREE.BufferGeometry {
  const orbit = new Float32Array(SWARM_COUNT * 4);
  const plane = new Float32Array(SWARM_COUNT * 3);
  const seed = new Float32Array(SWARM_COUNT * 2);
  for (let i = 0; i < SWARM_COUNT; i++) {
    const a = halfH * (0.9 + 0.7 * hash(i, 1));
    const ratio = 0.55 + 0.45 * hash(i, 2);
    const speed = (0.12 + 0.2 * hash(i, 3)) * (hash(i, 4) < 0.5 ? -1 : 1);
    orbit[i * 4] = a;
    orbit[i * 4 + 1] = ratio;
    orbit[i * 4 + 2] = speed;
    orbit[i * 4 + 3] = hash(i, 5) * Math.PI * 2;
    plane[i * 3] = (hash(i, 6) - 0.5) * Math.PI;
    plane[i * 3 + 1] = hash(i, 7) * Math.PI * 2;
    plane[i * 3 + 2] = (hash(i, 8) - 0.5) * 0.06;
    seed[i * 2] = hash(i, 9);
    seed[i * 2 + 1] = 0.7 + 0.6 * hash(i, 10);
  }
  const g = new THREE.BufferGeometry();
  // the position is computed in the shader; three still wants the attribute for the draw count
  g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(SWARM_COUNT * 3), 3));
  g.setAttribute("aOrbit", new THREE.BufferAttribute(orbit, 4));
  g.setAttribute("aPlane", new THREE.BufferAttribute(plane, 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 2));
  return g;
}

function prepare(scene: THREE.Group, parser: GltfParserLike, yaw: number): Prepared {
  const mesh = firstMesh(scene);
  const body = mesh ? mesh.geometry.clone() : new THREE.SphereGeometry(0.8, 48, 48);
  if (!body.attributes.normal) body.computeVertexNormals();
  if (yaw !== 0) body.rotateY(yaw);
  body.center();
  body.computeBoundingBox();
  const bb = body.boundingBox!;
  const height = Math.max(1e-3, bb.max.y - bb.min.y);
  // The body turns about its vertical axis, so a wide form (the black hole's
  // ring, the moth's wings) needs its full horizontal reach to fit, not just
  // its height: the larger of the two sets the scale.
  const pos = body.attributes.position as THREE.BufferAttribute;
  let reach = 0;
  for (let i = 0; i < pos.count; i++) reach = Math.max(reach, Math.hypot(pos.getX(i), pos.getZ(i)));
  const span = Math.max(height, 2 * reach * 0.92);
  const albedo = detectAlbedo(mesh, body, parser);
  const skin = makeSkin(body, SKIN_STRIDE);
  return { body, skin, swarm: makeSwarm(span / 2), base: TARGET_HEIGHT / span, halfH: height / 2, albedo };
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

function Body({ url, tint, yaw }: { url: string; tint: string; yaw: number }) {
  const gltf = useGLTF(url);
  const prepared = useMemo(() => prepare(gltf.scene, gltf.parser, yaw), [gltf, yaw]);
  const { body, skin, swarm, base, halfH, albedo } = prepared;
  // the model's half height over the original cat's, see bodyVert
  const unit = halfH / 0.95;
  const bare = albedo.kind === "none";
  useEffect(
    () => () => {
      body.dispose();
      skin.dispose();
      swarm.dispose();
      if (albedo.kind === "map") albedo.map.dispose();
    },
    [body, skin, swarm, albedo],
  );

  const defines = useMemo(() => {
    const d: Record<string, string> = {};
    if (albedo.kind !== "none") d.HAS_ALBEDO = "";
    if (albedo.kind === "map") d.HAS_MAP = "";
    if (albedo.kind === "vcolor") d.HAS_VCOLOR = "";
    return d;
  }, [albedo]);
  const bodyUniforms = useMemo(() => {
    const u: Record<string, THREE.IUniform> = {
      uTime: { value: 0 },
      uBurst: { value: 0 },
      uPulse: { value: 0 },
      uUnit: { value: unit },
      uTint: { value: new THREE.Color("#ffffff") },
    };
    if (albedo.kind !== "none") u.uBaseColor = { value: albedo.baseColor.clone() };
    if (albedo.kind === "map") {
      u.uMap = { value: albedo.map };
      u.uMapTransform = { value: albedo.mapTransform.clone() };
    }
    return u;
  }, [albedo, unit]);
  const skinUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uBurst: { value: 0 },
      uPixelRatio: { value: 1 },
      uUnit: { value: unit },
      uTint: { value: new THREE.Color("#ffffff") },
    }),
    [unit],
  );
  const swarmUniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uBurst: { value: 0 },
      uPixelRatio: { value: 1 },
      uRise: { value: halfH * 0.5 },
      uTint: { value: new THREE.Color("#ffffff") },
    }),
    [halfH],
  );
  const group = useRef<THREE.Group>(null);
  const bodyMat = useRef<THREE.ShaderMaterial>(null);
  const skinMat = useRef<THREE.ShaderMaterial>(null);
  const swarmMat = useRef<THREE.ShaderMaterial>(null);

  useFrame((state) => {
    const g = group.current;
    const bm = bodyMat.current;
    const sm = skinMat.current;
    const wm = swarmMat.current;
    if (!g || !bm || !sm || !wm) return;
    const t = state.clock.elapsedTime;
    decayDrag();

    // a slow turn; the drag adds to it and can go all the way round
    const targetY = t * 0.42 + catInput.spinX;
    const targetX = 0.1 + catInput.tiltY;
    g.rotation.y += (targetY - g.rotation.y) * (catInput.dragging ? 0.35 : 0.08);
    g.rotation.x += (targetX - g.rotation.x) * 0.1;

    const burst = petState.burstAt > 0 ? Math.max(0, 1 - (Date.now() - petState.burstAt) / 900) : 0;
    const breath = 1 + Math.sin(t * 1.6) * 0.012;
    const s = base * breath * (1 + burst * 0.07);
    g.scale.setScalar(s);
    g.position.y = Math.sin(t * 0.9) * 0.03 - 0.04;
    // the slow breath of the emissive highlights
    const pulse = Math.pow(0.5 + 0.5 * Math.sin(t * 1.3), 1.6);

    const pr = state.gl.getPixelRatio();
    bm.uniforms.uTime.value = t;
    bm.uniforms.uBurst.value = burst;
    bm.uniforms.uPulse.value = pulse;
    (bm.uniforms.uTint.value as THREE.Color).set(tint);
    sm.uniforms.uTime.value = t;
    sm.uniforms.uBurst.value = burst;
    sm.uniforms.uPixelRatio.value = pr;
    (sm.uniforms.uTint.value as THREE.Color).set(tint);
    wm.uniforms.uTime.value = t;
    wm.uniforms.uBurst.value = burst;
    wm.uniforms.uPixelRatio.value = pr;
    (wm.uniforms.uTint.value as THREE.Color).set(tint);
  });

  return (
    <group ref={group}>
      <mesh geometry={body}>
        <shaderMaterial
          key={albedo.kind}
          ref={bodyMat}
          uniforms={bodyUniforms}
          defines={defines}
          vertexShader={bodyVert}
          fragmentShader={bodyFrag}
          vertexColors={albedo.kind === "vcolor"}
          toneMapped={false}
        />
      </mesh>
      {/* the particles belong to the bare mesh's look; a textured model is shown as it is */}
      <points geometry={skin} visible={bare}>
        <shaderMaterial
          ref={skinMat}
          uniforms={skinUniforms}
          vertexShader={skinVert}
          fragmentShader={skinFrag}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
      <points geometry={swarm} frustumCulled={false}>
        <shaderMaterial
          ref={swarmMat}
          uniforms={swarmUniforms}
          vertexShader={swarmVert}
          fragmentShader={swarmFrag}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Error boundary                                                      */
/* ------------------------------------------------------------------ */

// A model that fails to load (a wrong ?model= path, a broken file) must not
// take the page down: the body is left empty with a one-line note.
class ModelBoundary extends Component<{ url: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("ModelCreature: model failed to load", this.props.url, error);
  }
  componentDidUpdate(prev: { url: string }) {
    if (prev.url !== this.props.url && this.state.failed) this.setState({ failed: false });
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="flex h-full w-full items-center justify-center">
          <span className="eyebrow text-[10px]">model failed to load</span>
        </div>
      );
    }
    return this.props.children;
  }
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

/** ?yaw=<radians> while tuning a form's modelYaw */
function yawOverride(): number | null {
  if (typeof window === "undefined") return null;
  const raw = new URLSearchParams(window.location.search).get("yaw");
  if (raw === null) return null;
  const v = Number(raw);
  return Number.isFinite(v) ? v : null;
}

export default function ModelCreature({
  url,
  tint = "#ffffff",
  yaw = 0,
}: {
  url: string;
  tint?: string;
  /** turns the model about its vertical axis (radians) so it faces the camera at phase zero */
  yaw?: number;
}) {
  const last = useRef<{ x: number; y: number } | null>(null);
  const [forcedYaw] = useState(yawOverride);

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
      <ModelBoundary url={url}>
        <Canvas dpr={[1, 1.5]} camera={{ position: [0, 0, 3.7], fov: 34 }} gl={{ alpha: true, antialias: true }}>
          <Suspense fallback={null}>
            <Body url={url} tint={tint} yaw={forcedYaw ?? yaw} />
          </Suspense>
        </Canvas>
      </ModelBoundary>
    </div>
  );
}
