import { Dimensions } from 'react-native';
import tgpu, { d, std } from 'typegpu';

// A pure-shader pond: a 2D wave-equation height field, no particles.
// One compute pass integrates the surface each frame; the fragment
// shader shades it (normals -> specular glints + refraction).
//
// The grid derives from the screen so cells stay square (~2.5pt) on any
// device — phone or iPad — and rings stay circular.
const win = Dimensions.get('window');
const CELL_PT = 2.5;
export const GW = Math.round(win.width / CELL_PT);
export const GH = Math.round(win.height / CELL_PT);
export const NUM_CELLS = GW * GH;

// The lake: an organic basin with a dry shore around it. Negative SDF
// = water. Shared by the sim (banks absorb waves) and the renderer
// (shore material, waterline).
const SHORE = Math.min(GW, GH) * 0.1;
const BANK_R = SHORE * 2.2;

export const lakeSdf = (p: d.v2f): number => {
  'use gpu';
  const rel = std.sub(p, d.vec2f(GW * 0.5, GH * 0.5));
  const q = std.sub(
    std.abs(rel),
    d.vec2f(GW * 0.5 - SHORE - BANK_R, GH * 0.5 - SHORE - BANK_R),
  );
  const sd =
    std.length(std.max(q, d.vec2f(0, 0))) +
    std.min(std.max(q.x, q.y), 0) -
    BANK_R;
  // Organic banks: low-frequency wobble along the shoreline.
  const wob =
    std.sin(p.x * 0.085) * 2.2 +
    std.sin(p.y * 0.063 + 1.7) * 2.6 +
    std.sin((p.x + p.y) * 0.041 + 0.6) * 2.0;
  return sd + wob;
};

export const MAX_DROPS = 6;
export const MAX_PROBES = 8;

export const Drop = d.struct({
  // grid coordinates
  pos: d.vec2f,
  amp: d.f32,
  radius: d.f32,
});

// UI elements (cards, title…) the water surface flows OVER. Inside these
// rounded rects the shader switches from opaque pond to a translucent
// lighting overlay so the content stays readable underneath.
export const MAX_RECTS = 8;
export const UiRect = d.struct({
  // all in grid coordinates
  center: d.vec2f,
  half: d.vec2f,
  r: d.f32,
});
export const RectArray = d.arrayOf(UiRect, MAX_RECTS);

export const SimUniforms = d.struct({
  // wave speed factor c^2*dt^2/dx^2 (stability: <= 0.5)
  k: d.f32,
  dampV: d.f32,
  dropCount: d.f32,
  // x, y in grid coords; z = amplitude, w = radius
  dimple: d.vec4f,
  // light direction for shading (tilt-driven on device)
  lightDir: d.vec2f,
  time: d.f32,
  // 0..1 — how strongly the sky/camera reflection shows on the water
  reflect: d.f32,
});

export const DropArray = d.arrayOf(Drop, MAX_DROPS);
export const HeightField = d.arrayOf(d.f32);
export const ProbePoints = d.arrayOf(d.vec2f, MAX_PROBES);
export const ProbeOut = d.arrayOf(d.f32, MAX_PROBES);

export const computeLayout = tgpu.bindGroupLayout({
  uni: { uniform: SimUniforms },
  drops: { uniform: DropArray },
  hSrc: { storage: HeightField, access: 'readonly' },
  hDst: { storage: HeightField, access: 'mutable' },
  vel: { storage: HeightField, access: 'mutable' },
});

export const renderLayout = tgpu.bindGroupLayout({
  uni: { uniform: SimUniforms },
  h: { storage: HeightField, access: 'readonly' },
  rects: { uniform: RectArray },
  // What the water mirrors: the front camera on device, a procedural
  // night sky on the simulator.
  reflection: { texture: 'float' },
  samp: { sampler: 'filtering' },
});

export const probeLayout = tgpu.bindGroupLayout({
  h: { storage: HeightField, access: 'readonly' },
  pts: { uniform: ProbePoints },
  out: { storage: ProbeOut, access: 'mutable' },
});

const cellIndex = (x: number, y: number): number => {
  'use gpu';
  const cx = std.clamp(x, 0, GW - 1);
  const cy = std.clamp(y, 0, GH - 1);
  return cy * GW + cx;
};

export const updateField = (idx: number) => {
  'use gpu';
  const uni = computeLayout.$.uni;
  // JS `/` is float division (TGSL keeps those semantics) — derive the
  // row/col with explicit floor + subtraction so indices stay exact.
  const y = d.i32(std.floor(d.f32(idx) / GW));
  const x = d.i32(idx) - y * GW;

  const hC = computeLayout.$.hSrc[idx];
  const lap =
    computeLayout.$.hSrc[cellIndex(x - 1, y)] +
    computeLayout.$.hSrc[cellIndex(x + 1, y)] +
    computeLayout.$.hSrc[cellIndex(x, y - 1)] +
    computeLayout.$.hSrc[cellIndex(x, y + 1)] -
    4 * hC;

  const p = d.vec2f(d.f32(x), d.f32(y));
  // 1 in open water, 0 on the shore — banks absorb waves instead of
  // reflecting them, and the finger can't disturb dry land.
  const sd = lakeSdf(p);
  const inside = std.smoothstep(1.5, -1.5, sd);

  let v = (computeLayout.$.vel[idx] + uni.k * lap) * uni.dampV;
  v = v * std.mix(0.86, 1, inside);

  // Drops: each one kicks the surface with a gaussian impulse.
  for (let i = 0; i < MAX_DROPS; i++) {
    if (d.f32(i) < uni.dropCount) {
      const drop = computeLayout.$.drops[i];
      const dv = std.sub(p, drop.pos);
      const g = std.exp(-std.dot(dv, dv) / (drop.radius * drop.radius));
      v -= drop.amp * g * inside;
    }
  }

  computeLayout.$.vel[idx] = v;
  let nh = (hC + v) * std.mix(0.92, 1, inside);

  // The held "rock": surface tension dent that deepens with the pull.
  if (uni.dimple.z > 0.001) {
    const dd = std.sub(p, d.vec2f(uni.dimple.x, uni.dimple.y));
    const g = std.exp(-std.dot(dd, dd) / (uni.dimple.w * uni.dimple.w));
    nh = std.mix(nh, -uni.dimple.z, g * 0.22 * inside);
  }

  computeLayout.$.hDst[idx] = nh;
};

export const readProbes = (idx: number) => {
  'use gpu';
  const pt = probeLayout.$.pts[idx];
  const x = d.i32(pt.x * GW);
  const y = d.i32(pt.y * GH);
  probeLayout.$.out[idx] = probeLayout.$.h[cellIndex(x, y)];
};

export const heightAt = (x: number, y: number): number => {
  'use gpu';
  return renderLayout.$.h[cellIndex(x, y)];
};

// 0 outside all UI rects, 1 inside (anti-aliased rounded-rect SDF union).
export const uiMask = (p: d.v2f): number => {
  'use gpu';
  let m = d.f32(0);
  for (let i = 0; i < MAX_RECTS; i++) {
    const rc = renderLayout.$.rects[i];
    if (rc.r > 0) {
      const q = std.sub(
        std.abs(std.sub(p, rc.center)),
        std.sub(rc.half, d.vec2f(rc.r, rc.r)),
      );
      const sd =
        std.length(std.max(q, d.vec2f(0, 0))) +
        std.min(std.max(q.x, q.y), 0) -
        rc.r;
      m = std.max(m, std.smoothstep(0.75, -0.75, sd));
    }
  }
  return m;
};

// Bilinear height sample at fractional grid coords — the render pass
// must NOT sample nearest-neighbor or cell-frequency ripples moiré
// into stripes.
export const heightBilinear = (px: number, py: number): number => {
  'use gpu';
  const fx = px - 0.5;
  const fy = py - 0.5;
  const x0 = d.i32(std.floor(fx));
  const y0 = d.i32(std.floor(fy));
  const tx = fx - std.floor(fx);
  const ty = fy - std.floor(fy);
  const h00 = heightAt(x0, y0);
  const h10 = heightAt(x0 + 1, y0);
  const h01 = heightAt(x0, y0 + 1);
  const h11 = heightAt(x0 + 1, y0 + 1);
  return std.mix(std.mix(h00, h10, tx), std.mix(h01, h11, tx), ty);
};
