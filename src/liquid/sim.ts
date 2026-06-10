import tgpu, { d, std } from 'typegpu';
import { MAX_SHAPES } from './layout';

// World space: x in [0, aspect], y in [0, 1] over the full screen,
// y grows downward (gravity is +y).
//
// The water is a closed system: all particles live permanently inside the
// union of capsule shapes (reservoir, pipes, tank). The pump force pushes
// them along pipe segments; gravity brings them back.
export const N_PARTICLES = 820;
export const CELL = 0.0125;
export const GX = 38; // covers aspect up to 0.475 (portrait phones)
export const GY = 80;
export const NUM_CELLS = GX * GY;
export const MAX_PER_CELL = 10;
export const NUM_SLOTS = NUM_CELLS * MAX_PER_CELL;
export const GRAVITY = 3.2;

const SENTINEL = 0xffffffff;

export const H = 0.012; // particle interaction radius (must stay <= CELL)
const PR = 0.0045; // particle radius against walls
const REPULSION = 24;
const VISCOSITY = 5;
const DAMPING = 0.998;
const V_MAX = 1.4;
const PUMP_ACCEL = 16;
const SDF_EPS = 0.0015;

export const SimUniforms = d.struct({
  gravity: d.vec2f,
  aspect: d.f32,
  // 0..1 — pump strength (pull progress / refreshing hold).
  pump: d.f32,
  dt: d.f32,
  time: d.f32,
});

export const Particle = d.struct({
  pos: d.vec2f,
  vel: d.vec2f,
});

export const Capsule = d.struct({
  a: d.vec2f,
  b: d.vec2f,
  r: d.f32,
  flow: d.f32,
});

export const ShapeArray = d.arrayOf(Capsule, MAX_SHAPES);

export const computeLayout = tgpu.bindGroupLayout({
  uni: { uniform: SimUniforms },
  shapes: { storage: ShapeArray, access: 'readonly' },
  particles: { storage: d.arrayOf(Particle), access: 'mutable' },
  counts: { storage: d.arrayOf(d.atomic(d.u32)), access: 'mutable' },
  slots: { storage: d.arrayOf(d.u32), access: 'mutable' },
});

export const renderLayout = tgpu.bindGroupLayout({
  uni: { uniform: SimUniforms },
  shapes: { storage: ShapeArray, access: 'readonly' },
  particles: { storage: d.arrayOf(Particle), access: 'readonly' },
  slots: { storage: d.arrayOf(d.u32), access: 'readonly' },
});

const cellCoord = (p: d.v2f): d.v2i => {
  'use gpu';
  const cx = std.clamp(d.i32(p.x / CELL), 0, GX - 1);
  const cy = std.clamp(d.i32(p.y / CELL), 0, GY - 1);
  return d.vec2i(cx, cy);
};

const segDistance = (p: d.v2f, a: d.v2f, b: d.v2f): number => {
  'use gpu';
  const pa = std.sub(p, a);
  const ba = std.sub(b, a);
  const t = std.clamp(std.dot(pa, ba) / std.max(std.dot(ba, ba), 1e-8), 0, 1);
  return std.length(std.sub(pa, std.mul(t, ba)));
};

// Signed distance to the inside of the plumbing (negative = inside water
// space). Shared by sim collisions and the glass-wall renderer.
export const plumbingSdfCompute = (p: d.v2f): number => {
  'use gpu';
  let sd = d.f32(10);
  for (let i = 0; i < MAX_SHAPES; i++) {
    const s = computeLayout.$.shapes[i];
    sd = std.min(sd, segDistance(p, s.a, s.b) - s.r);
  }
  return sd;
};

export const plumbingSdfRender = (p: d.v2f): number => {
  'use gpu';
  let sd = d.f32(10);
  for (let i = 0; i < MAX_SHAPES; i++) {
    const s = renderLayout.$.shapes[i];
    sd = std.min(sd, segDistance(p, s.a, s.b) - s.r);
  }
  return sd;
};

export const clearCells = (idx: number) => {
  'use gpu';
  computeLayout.$.slots[idx] = SENTINEL;
  if (idx < NUM_CELLS) {
    std.atomicStore(computeLayout.$.counts[idx], 0);
  }
};

export const binParticles = (idx: number) => {
  'use gpu';
  const p = computeLayout.$.particles[idx];
  const c = cellCoord(p.pos);
  const cellIdx = c.y * GX + c.x;
  const k = std.atomicAdd(computeLayout.$.counts[cellIdx], 1);
  if (k < d.u32(MAX_PER_CELL)) {
    computeLayout.$.slots[cellIdx * MAX_PER_CELL + k] = idx;
  }
};

export const simulate = (idx: number) => {
  'use gpu';
  const uni = computeLayout.$.uni;
  const p = computeLayout.$.particles[idx];

  let force = d.vec2f(uni.gravity);

  // Pump: pipe segments push the water along their flow direction.
  let inPipe = d.f32(0);
  for (let i = 0; i < MAX_SHAPES; i++) {
    const s = computeLayout.$.shapes[i];
    if (s.flow > 0.5) {
      const dist = segDistance(p.pos, s.a, s.b);
      if (dist < s.r + H * 0.5) {
        const dir = std.normalize(std.sub(s.b, s.a));
        force = std.add(force, std.mul(PUMP_ACCEL * uni.pump, dir));
        inPipe = 1;
      }
    }
  }

  // Neighbor repulsion + viscosity via the spatial hash.
  const c = cellCoord(p.pos);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = c.x + dx;
      const cy = c.y + dy;
      if (cx < 0 || cx >= GX || cy < 0 || cy >= GY) {
        continue;
      }
      const base = (cy * GX + cx) * MAX_PER_CELL;
      for (let k = 0; k < MAX_PER_CELL; k++) {
        const j = computeLayout.$.slots[base + k];
        if (j === SENTINEL) {
          break;
        }
        if (j === idx) {
          continue;
        }
        const other = computeLayout.$.particles[j];
        const dvec = std.sub(p.pos, other.pos);
        const r = std.length(dvec);
        if (r < H && r > 1e-5) {
          const q = 1 - r / H;
          force = std.add(force, std.mul((REPULSION * q * q) / r, dvec));
          force = std.add(
            force,
            std.mul(VISCOSITY * q, std.sub(other.vel, p.vel)),
          );
        }
      }
    }
  }

  let vel = std.add(p.vel, std.mul(uni.dt, force));
  const speed = std.length(vel);
  if (speed > V_MAX) {
    vel = std.mul(V_MAX / speed, vel);
  }
  vel = std.mul(DAMPING, vel);

  // Check valve: while the pump runs, water cannot fall back down the
  // pipes — this is what lets the tank actually fill up.
  if (inPipe > 0.5 && uni.pump > 0.05 && vel.y > 0) {
    vel.y = vel.y * 0.05;
  }
  let pos = std.add(p.pos, std.mul(uni.dt, vel));

  // Containment: project back inside the plumbing and kill the outward
  // velocity component (water slides along glass).
  const sd = plumbingSdfCompute(pos);
  if (sd > -PR) {
    const gx =
      plumbingSdfCompute(d.vec2f(pos.x + SDF_EPS, pos.y)) -
      plumbingSdfCompute(d.vec2f(pos.x - SDF_EPS, pos.y));
    const gy =
      plumbingSdfCompute(d.vec2f(pos.x, pos.y + SDF_EPS)) -
      plumbingSdfCompute(d.vec2f(pos.x, pos.y - SDF_EPS));
    const gl = std.max(std.length(d.vec2f(gx, gy)), 1e-6);
    const n = d.vec2f(gx / gl, gy / gl);
    pos = std.sub(pos, std.mul(sd + PR, n));
    const vn = std.dot(vel, n);
    if (vn > 0) {
      vel = std.sub(vel, std.mul(vn * 1.4, n));
    }
  }

  p.pos = d.vec2f(pos);
  p.vel = d.vec2f(vel);
};

export const sampleDensity = (world: d.v2f): number => {
  'use gpu';
  let density = d.f32(0);
  const c = cellCoord(world);

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      // Deep interior pixels saturate fast — every shading term clamps
      // by ~2, so stop gathering once past it.
      if (density > 2.2) {
        return density;
      }
      const cx = c.x + dx;
      const cy = c.y + dy;
      if (cx < 0 || cx >= GX || cy < 0 || cy >= GY) {
        continue;
      }
      const base = (cy * GX + cx) * MAX_PER_CELL;
      for (let k = 0; k < MAX_PER_CELL; k++) {
        const j = renderLayout.$.slots[base + k];
        if (j === SENTINEL) {
          break;
        }
        const dvec = std.sub(world, renderLayout.$.particles[j].pos);
        const r2 = std.dot(dvec, dvec);
        const q = std.max(0, 1 - r2 / (H * H));
        density += q * q;
      }
    }
  }

  return density;
};
