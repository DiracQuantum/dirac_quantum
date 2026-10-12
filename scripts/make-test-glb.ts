/**
 * Writes public/models/test-textured.glb: a small textured model for testing
 * the textured path of src/components/three/ModelCreature.tsx without a Meshy
 * export at hand. Run from the project root:
 *   node scripts/make-test-glb.ts
 *
 * The model is a UV sphere (radius 0.8, 48 x 32 segments) with normals and
 * UVs, one material whose baseColorTexture is a 64 x 64 PNG embedded in the
 * binary chunk: a dark blue gradient, two bright cyan eyes on the side facing
 * +z (the camera), a faint cyan ring and a small white spot on the back. The
 * PNG is encoded here with zlib, the GLB by hand (header, JSON chunk padded
 * with spaces, BIN chunk padded with zeros, 4-byte alignment). The script
 * re-reads the file and checks the layout before reporting.
 *
 * Test it at /pet?motion=force&model=/models/test-textured.glb: the gradient
 * and eyes must show, the eyes must pulse, the spark swarm must orbit.
 *
 * With --vcolor (`node scripts/make-test-glb.ts --vcolor`) it also writes
 * public/models/test-vcolor.glb: the same sphere with the picture baked into
 * COLOR_0 vertex colours and no texture or material, for the vertex-colour
 * path (/pet?motion=force&model=/models/test-vcolor.glb). No form ships
 * vertex colours, so that file is not kept in public/models: delete it after
 * the test, or it is deployed with the site.
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outPath = join(root, "public", "models", "test-textured.glb");
const outVColorPath = join(root, "public", "models", "test-vcolor.glb");

/* ------------------------------------------------------------------ */
/* PNG                                                                 */
/* ------------------------------------------------------------------ */

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(Buffer.from(type, "ascii"), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGB 8-bit PNG from a pixel buffer (3 bytes per pixel, rows top to bottom). */
function encodePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0; // filter: none
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = new Uint8Array(deflateSync(raw, { level: 9 }));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

const TEX = 64;

// u runs round the sphere, v from the top (glTF UV origin is top-left); the
// +z side, which faces the camera, is u = 0.25.
const EYES = [
  [0.19, 0.42],
  [0.31, 0.42],
];
const SPOT = [0.75, 0.3];

/** The picture at one UV point, 0..255 per channel (sRGB). */
function paint(u: number, v: number): [number, number, number] {
  // dark blue gradient, a little lighter towards the top and the front
  const front = 0.5 + 0.5 * Math.cos((u - 0.25) * Math.PI * 2);
  let r = 10 + 14 * (1 - v) + 6 * front;
  let g = 16 + 22 * (1 - v) + 10 * front;
  let b = 44 + 46 * (1 - v) + 18 * front;
  // a faint cyan ring, not bright enough to glow: shows the mapping
  const ring = Math.exp(-Math.pow((v - 0.72) / 0.025, 2));
  r += 10 * ring;
  g += 60 * ring;
  b += 70 * ring;
  // the eyes: a cyan disc with a white core
  for (const [eu, ev] of EYES) {
    const d = Math.hypot((u - eu) * TEX, (v - ev) * TEX);
    const disc = 1 - smooth(2.6, 3.6, d);
    const core = 1 - smooth(0.6, 1.6, d);
    r = mix(r, 40, disc);
    g = mix(g, 235, disc);
    b = mix(b, 255, disc);
    r = mix(r, 235, core);
    g = mix(g, 255, core);
    b = mix(b, 255, core);
  }
  // a small white spot on the back: the "very bright overall" case
  const ds = Math.hypot((u - SPOT[0]) * TEX, (v - SPOT[1]) * TEX);
  const white = 1 - smooth(1.2, 2.2, ds);
  r = mix(r, 250, white);
  g = mix(g, 250, white);
  b = mix(b, 250, white);
  return [clamp8(r), clamp8(g), clamp8(b)];
}

/** The picture as a TEX x TEX RGB buffer. */
function paintTexture(): Uint8Array {
  const rgb = new Uint8Array(TEX * TEX * 3);
  for (let y = 0; y < TEX; y++) {
    for (let x = 0; x < TEX; x++) {
      const [r, g, b] = paint((x + 0.5) / TEX, (y + 0.5) / TEX);
      const i = (y * TEX + x) * 3;
      rgb[i] = r;
      rgb[i + 1] = g;
      rgb[i + 2] = b;
    }
  }
  return rgb;
}

/** sRGB 0..255 to linear 0..1 (glTF vertex colours are linear). */
function srgbToLinear(c: number): number {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function clamp8(x: number): number {
  return Math.max(0, Math.min(255, Math.round(x)));
}

/* ------------------------------------------------------------------ */
/* Sphere                                                              */
/* ------------------------------------------------------------------ */

const RADIUS = 0.8;
const W = 48;
const H = 32;

function makeSphere() {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let iy = 0; iy <= H; iy++) {
    const v = iy / H;
    for (let ix = 0; ix <= W; ix++) {
      const u = ix / W;
      const x = -Math.cos(u * Math.PI * 2) * Math.sin(v * Math.PI);
      const y = Math.cos(v * Math.PI);
      const z = Math.sin(u * Math.PI * 2) * Math.sin(v * Math.PI);
      positions.push(x * RADIUS, y * RADIUS, z * RADIUS);
      normals.push(x, y, z);
      uvs.push(u, v);
    }
  }
  for (let iy = 0; iy < H; iy++) {
    for (let ix = 0; ix < W; ix++) {
      const a = iy * (W + 1) + ix + 1;
      const b = iy * (W + 1) + ix;
      const c = (iy + 1) * (W + 1) + ix;
      const d = (iy + 1) * (W + 1) + ix + 1;
      if (iy !== 0) indices.push(a, b, d);
      if (iy !== H - 1) indices.push(b, c, d);
    }
  }
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: new Uint16Array(indices),
  };
}

/* ------------------------------------------------------------------ */
/* GLB                                                                 */
/* ------------------------------------------------------------------ */

function pad4(n: number): number {
  return (n + 3) & ~3;
}

function minMax(arr: Float32Array, size: number): { min: number[]; max: number[] } {
  const min = new Array<number>(size).fill(Infinity);
  const max = new Array<number>(size).fill(-Infinity);
  for (let i = 0; i < arr.length; i += size) {
    for (let k = 0; k < size; k++) {
      min[k] = Math.min(min[k], arr[i + k]);
      max[k] = Math.max(max[k], arr[i + k]);
    }
  }
  return { min, max };
}

function buildGlb(variant: "textured" | "vcolor"): Uint8Array {
  const sphere = makeSphere();
  // the vertex-colour variant bakes the picture per vertex (linear, VEC3 float)
  const colors = new Float32Array((sphere.uvs.length / 2) * 3);
  for (let i = 0; i < sphere.uvs.length / 2; i++) {
    const [r, g, b] = paint(sphere.uvs[i * 2], sphere.uvs[i * 2 + 1]);
    colors[i * 3] = srgbToLinear(r);
    colors[i * 3 + 1] = srgbToLinear(g);
    colors[i * 3 + 2] = srgbToLinear(b);
  }
  const png = encodePng(TEX, TEX, paintTexture());

  // binary chunk: every view starts at a 4-byte boundary
  const parts: { bytes: Uint8Array; target?: number }[] = [
    { bytes: new Uint8Array(sphere.positions.buffer), target: 34962 },
    { bytes: new Uint8Array(sphere.normals.buffer), target: 34962 },
    { bytes: new Uint8Array(sphere.uvs.buffer), target: 34962 },
    { bytes: new Uint8Array(sphere.indices.buffer), target: 34963 },
    variant === "textured" ? { bytes: png } : { bytes: new Uint8Array(colors.buffer), target: 34962 },
  ];
  const bufferViews: { buffer: number; byteOffset: number; byteLength: number; target?: number }[] = [];
  let offset = 0;
  for (const part of parts) {
    const view: (typeof bufferViews)[number] = { buffer: 0, byteOffset: offset, byteLength: part.bytes.length };
    if (part.target !== undefined) view.target = part.target;
    bufferViews.push(view);
    offset = pad4(offset + part.bytes.length);
  }
  const bin = new Uint8Array(offset);
  parts.forEach((part, i) => bin.set(part.bytes, bufferViews[i].byteOffset));

  const vertexCount = sphere.positions.length / 3;
  const pos = minMax(sphere.positions, 3);
  const textured = variant === "textured";
  const json = {
    asset: { version: "2.0", generator: "dirac scripts/make-test-glb.ts" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: textured ? "test_textured" : "test_vcolor" }],
    meshes: [
      {
        name: "sphere",
        primitives: [
          textured
            ? { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0, mode: 4 }
            : { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2, COLOR_0: 4 }, indices: 3, mode: 4 },
        ],
      },
    ],
    ...(textured
      ? {
          materials: [
            {
              name: "painted",
              pbrMetallicRoughness: {
                baseColorTexture: { index: 0, texCoord: 0 },
                metallicFactor: 0,
                roughnessFactor: 0.9,
              },
            },
          ],
          textures: [{ source: 0, sampler: 0 }],
          images: [{ bufferView: 4, mimeType: "image/png", name: "painted" }],
          samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
        }
      : {}),
    accessors: [
      { bufferView: 0, componentType: 5126, count: vertexCount, type: "VEC3", min: pos.min, max: pos.max },
      { bufferView: 1, componentType: 5126, count: vertexCount, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: vertexCount, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: sphere.indices.length, type: "SCALAR" },
      ...(textured ? [] : [{ bufferView: 4, componentType: 5126, count: vertexCount, type: "VEC3" }]),
    ],
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };

  const jsonBytes = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPadded = new Uint8Array(pad4(jsonBytes.length)).fill(0x20);
  jsonPadded.set(jsonBytes);

  const total = 12 + 8 + jsonPadded.length + 8 + bin.length;
  const glb = new Uint8Array(total);
  const view = new DataView(glb.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded.length, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  glb.set(jsonPadded, 20);
  const binStart = 20 + jsonPadded.length;
  view.setUint32(binStart, bin.length, true);
  view.setUint32(binStart + 4, 0x004e4942, true); // "BIN\0"
  glb.set(bin, binStart + 8);
  return glb;
}

/* ------------------------------------------------------------------ */
/* Write and check                                                     */
/* ------------------------------------------------------------------ */

function check(path: string): string {
  const b = readFileSync(path);
  const u32 = (o: number) => b.readUInt32LE(o);
  if (u32(0) !== 0x46546c67 || u32(4) !== 2) throw new Error("bad header");
  if (u32(8) !== b.length) throw new Error(`length ${u32(8)} vs file ${b.length}`);
  const jsonLen = u32(12);
  if (u32(16) !== 0x4e4f534a || jsonLen % 4 !== 0) throw new Error("bad JSON chunk");
  const json = JSON.parse(b.subarray(20, 20 + jsonLen).toString("utf8"));
  const binStart = 20 + jsonLen;
  const binLen = u32(binStart);
  if (u32(binStart + 4) !== 0x004e4942 || binLen % 4 !== 0) throw new Error("bad BIN chunk");
  if (binStart + 8 + binLen !== b.length) throw new Error("BIN chunk does not end the file");
  if (json.buffers[0].byteLength !== binLen) throw new Error("buffer length mismatch");
  for (const v of json.bufferViews) {
    if (v.byteOffset % 4 !== 0) throw new Error("unaligned bufferView");
    if (v.byteOffset + v.byteLength > binLen) throw new Error("bufferView past the end");
  }
  const prim = json.meshes[0].primitives[0];
  if (prim.attributes.TEXCOORD_0 === undefined) throw new Error("no UVs");
  const summary = `${b.length} bytes, ${json.accessors[0].count} vertices, ${json.accessors[3].count / 3} triangles`;
  if (json.images) {
    const img = json.bufferViews[json.images[0].bufferView];
    const sig = b.subarray(binStart + 8 + img.byteOffset, binStart + 8 + img.byteOffset + 8);
    if (sig.toString("hex") !== "89504e470d0a1a0a") throw new Error("embedded image is not a PNG");
    if (json.materials[0].pbrMetallicRoughness.baseColorTexture === undefined) throw new Error("no baseColorTexture");
    return `${summary}, PNG ${img.byteLength} bytes`;
  }
  if (prim.attributes.COLOR_0 === undefined) throw new Error("no COLOR_0");
  return `${summary}, COLOR_0 vertex colours`;
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, buildGlb("textured"));
console.log(`wrote ${outPath}: ${check(outPath)}`);
if (process.argv.includes("--vcolor")) {
  writeFileSync(outVColorPath, buildGlb("vcolor"));
  console.log(`wrote ${outVColorPath}: ${check(outVColorPath)}`);
}
