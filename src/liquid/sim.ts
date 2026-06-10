import tgpu, { d, std } from 'typegpu';

// A pure-shader pond: a 2D wave-equation height field, no particles.
// One compute pass integrates the surface each frame; the fragment
// shader shades it (normals -> specular glints + refraction).
//
// Grid cells are ~2.45pt squares on a 393x852 phone, so rings stay
// circular. Other aspect ratios distort imperceptibly.
export const GW = 160;
export const GH = 348;
export const NUM_CELLS = GW * GH;

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

  let v = (computeLayout.$.vel[idx] + uni.k * lap) * uni.dampV;

  // Drops: each one kicks the surface with a gaussian impulse.
  const p = d.vec2f(d.f32(x), d.f32(y));
  for (let i = 0; i < MAX_DROPS; i++) {
    if (d.f32(i) < uni.dropCount) {
      const drop = computeLayout.$.drops[i];
      const dv = std.sub(p, drop.pos);
      const g = std.exp(-std.dot(dv, dv) / (drop.radius * drop.radius));
      v -= drop.amp * g;
    }
  }

  computeLayout.$.vel[idx] = v;
  let nh = hC + v;

  // The held "rock": surface tension dent that deepens with the pull.
  if (uni.dimple.z > 0.001) {
    const dd = std.sub(p, d.vec2f(uni.dimple.x, uni.dimple.y));
    const g = std.exp(-std.dot(dd, dd) / (uni.dimple.w * uni.dimple.w));
    nh = std.mix(nh, -uni.dimple.z, g * 0.22);
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
