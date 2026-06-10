import tgpu, { d, std } from 'typegpu';

// World space: x in [0, aspect], y in [0, 1], y grows downward (gravity is +y).
export const N_PARTICLES = 2000;
export const CELL = 0.05;
export const GX = 80; // supports canvases up to aspect ratio 4
export const GY = 20;
export const NUM_CELLS = GX * GY;
export const MAX_PER_CELL = 16;
export const NUM_SLOTS = NUM_CELLS * MAX_PER_CELL;
export const GRAVITY = 12;

const SENTINEL = 0xffffffff;

const H = 0.05; // particle interaction radius (must stay <= CELL for 3x3 search)
const REPULSION = 50;
const VISCOSITY = 6;
const DAMPING = 0.999;
const V_MAX = 3;
const WALL_BOUNCE = 0.3;
const MARGIN = 0.02;
// Keep the water surface flush with the content sheet below it.
const FLOOR_MARGIN = 0.005;

export const SimUniforms = d.struct({
  gravity: d.vec2f,
  aspect: d.f32,
  activeCount: d.f32,
  drainOpen: d.f32,
  // Water floor in world space (0..1) — tracks the top edge of the
  // scroll content so the water rests exactly in the revealed gap.
  floorY: d.f32,
  dt: d.f32,
  time: d.f32,
});

export const Particle = d.struct({
  pos: d.vec2f,
  vel: d.vec2f,
});

export const computeLayout = tgpu.bindGroupLayout({
  uni: { uniform: SimUniforms },
  particles: { storage: d.arrayOf(Particle), access: 'mutable' },
  counts: { storage: d.arrayOf(d.atomic(d.u32)), access: 'mutable' },
  slots: { storage: d.arrayOf(d.u32), access: 'mutable' },
});

export const renderLayout = tgpu.bindGroupLayout({
  uni: { uniform: SimUniforms },
  particles: { storage: d.arrayOf(Particle), access: 'readonly' },
  slots: { storage: d.arrayOf(d.u32), access: 'readonly' },
});

const hash = (n: number): number => {
  'use gpu';
  return std.fract(std.sin(n * 12.9898) * 43758.547);
};

const cellCoord = (p: d.v2f): d.v2i => {
  'use gpu';
  const cx = std.clamp(d.i32(p.x / CELL), 0, GX - 1);
  const cy = std.clamp(d.i32(p.y / CELL), 0, GY - 1);
  return d.vec2i(cx, cy);
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
  if (d.f32(idx) >= computeLayout.$.uni.activeCount) {
    return;
  }
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

  if (d.f32(idx) >= uni.activeCount) {
    // Parked above the canvas, staggered along the pour column,
    // so newly activated particles rain in instead of teleporting.
    const r1 = hash(d.f32(idx));
    const r2 = hash(d.f32(idx) + 0.17);
    p.pos = d.vec2f(uni.aspect * 0.5 + (r1 - 0.5) * 0.2, -0.06 - r2 * 1.2);
    p.vel = d.vec2f(0, 0);
    return;
  }

  let force = d.vec2f(uni.gravity);
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
  const pos = std.add(p.pos, std.mul(uni.dt, vel));

  if (pos.x < MARGIN) {
    pos.x = MARGIN;
    vel.x = std.abs(vel.x) * WALL_BOUNCE;
  }
  if (pos.x > uni.aspect - MARGIN) {
    pos.x = uni.aspect - MARGIN;
    vel.x = -std.abs(vel.x) * WALL_BOUNCE;
  }
  if (uni.drainOpen < 0.5) {
    if (pos.y > uni.floorY - FLOOR_MARGIN) {
      pos.y = uni.floorY - FLOOR_MARGIN;
      vel.y = -std.abs(vel.y) * WALL_BOUNCE;
    }
  } else if (pos.y > 1.5) {
    // Drained out of view; hold far below until the next fill cycle reparks it.
    pos.x = uni.aspect * 0.5;
    pos.y = 2.0;
    vel = d.vec2f(0, 0);
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
