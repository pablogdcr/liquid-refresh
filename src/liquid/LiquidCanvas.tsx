import { useMemo, type RefObject } from 'react';
import { PixelRatio, type StyleProp, type ViewStyle } from 'react-native';
import { Canvas } from 'react-native-wgpu';
import { common, d, std } from 'typegpu';
import {
  useBindGroup,
  useConfigureContext,
  useFrame,
  useMutable,
  useReadonly,
  useRoot,
  useUniform,
} from '@typegpu/react';
import {
  binParticles,
  clearCells,
  computeLayout,
  GRAVITY,
  N_PARTICLES,
  NUM_CELLS,
  NUM_SLOTS,
  Particle,
  plumbingSdfRender,
  renderLayout,
  sampleDensity,
  ShapeArray,
  simulate,
  SimUniforms,
} from './sim';
import {
  CAPSULES_PT,
  MARGIN,
  RESERVOIR_CY,
  RESERVOIR_R,
  toWorld,
} from './layout';

export interface LiquidState {
  /** 0..1 — pump strength (pull progress, held at 1 while refreshing). */
  pump: number;
  /** Unit-ish gravity direction in canvas space (x right, y down). */
  gravity: { x: number; y: number };
}

interface LiquidCanvasProps {
  stateRef: RefObject<LiquidState>;
  style?: StyleProp<ViewStyle>;
}

// Slightly slower than real time — the water feels heavier, and one
// substep keeps the JS thread free for scrolling.
const DT = 1 / 100;
// Metaballs are soft gradients; rendering at reduced resolution is
// invisible after compositing and cuts fragment cost ~4x.
const RESOLUTION_SCALE = 0.45;

// Capture rig: the iOS simulator throttles canvas presents to ~15fps no
// matter the workload. Setting `globalThis.__SLOWMO = 4` runs the sim at
// quarter speed — record, then speed the video 4x for a smooth 60fps clip.
const slowmo = () =>
  (globalThis as unknown as { __SLOWMO?: number }).__SLOWMO ?? 1;

const worldShapes = CAPSULES_PT.map((c) => ({
  a: d.vec2f(toWorld(c.ax), toWorld(c.ay)),
  b: d.vec2f(toWorld(c.bx), toWorld(c.by)),
  r: toWorld(c.r),
  flow: c.flow,
}));

function initialParticles() {
  // All the water starts in the reservoir.
  const xMin = toWorld(MARGIN + 10);
  const xMax = toWorld(CAPSULES_PT[1].bx + RESERVOIR_R - 10);
  const yMid = toWorld(RESERVOIR_CY);
  const yHalf = toWorld(RESERVOIR_R - 8);
  return Array.from({ length: N_PARTICLES }, () => ({
    pos: d.vec2f(
      xMin + Math.random() * (xMax - xMin),
      yMid + (Math.random() * 2 - 1) * yHalf,
    ),
    vel: d.vec2f(0, 0),
  }));
}

export function LiquidCanvas({ stateRef, style }: LiquidCanvasProps) {
  const root = useRoot();

  const particles = useMutable(d.arrayOf(Particle, N_PARTICLES), {
    initial: (buffer) => buffer.write(initialParticles()),
  });
  const counts = useMutable(d.arrayOf(d.atomic(d.u32), NUM_CELLS));
  const slots = useMutable(d.arrayOf(d.u32, NUM_SLOTS));
  const shapes = useReadonly(ShapeArray, { initial: worldShapes });
  const uni = useUniform(SimUniforms, {
    initial: {
      gravity: d.vec2f(0, GRAVITY),
      aspect: 0.46,
      pump: 0,
      dt: DT,
      time: 0,
    },
  });

  const computeGroup = useBindGroup(computeLayout, {
    uni: uni.buffer,
    shapes: shapes.buffer,
    particles: particles.buffer,
    counts: counts.buffer,
    slots: slots.buffer,
  });
  const renderGroup = useBindGroup(renderLayout, {
    uni: uni.buffer,
    shapes: shapes.buffer,
    particles: particles.buffer,
    slots: slots.buffer,
  });

  const clearPipeline = useMemo(
    () => root.createGuardedComputePipeline(clearCells),
    [root],
  );
  const binPipeline = useMemo(
    () => root.createGuardedComputePipeline(binParticles),
    [root],
  );
  const simPipeline = useMemo(
    () => root.createGuardedComputePipeline(simulate),
    [root],
  );

  const renderPipeline = useMemo(
    () =>
      root.createRenderPipeline({
        vertex: common.fullScreenTriangle,
        fragment: ({ uv }) => {
          'use gpu';
          const uniR = renderLayout.$.uni;
          const world = d.vec2f(uv.x * uniR.aspect, uv.y);

          // Glass plumbing: thin ice wall where |sdf| ~ 0, faint tint inside.
          const sd = plumbingSdfRender(world);
          const wall =
            std.smoothstep(0.004, 0.0012, std.abs(sd)) *
            std.smoothstep(-0.012, 0.0, sd) ;
          const inside = std.smoothstep(0.001, -0.002, sd);
          const glassA = wall * 0.4 + inside * 0.045;
          const glassRgb = std.mul(glassA, d.vec3f(0.56, 0.8, 1));

          // Water (clipped to the inside of the plumbing).
          const density = sampleDensity(world);
          const grad = d.vec2f(std.dpdx(density), std.dpdy(density));
          const gradLen = std.max(std.length(grad), 1e-4);
          const n = std.mul(-1 / gradLen, grad);

          const mask = std.smoothstep(0.42, 0.7, density) * inside;
          const depth = std.smoothstep(0.5, 1.2, density);

          const ice = d.vec3f(0.5, 0.8, 1.0);
          const deepBlue = d.vec3f(0.06, 0.3, 0.68);
          let col = std.mix(ice, deepBlue, depth);

          const edge =
            std.smoothstep(0.015, 0.05, gradLen) *
            (1 - std.smoothstep(0.8, 1.0, density));
          const lightDir = std.normalize(d.vec2f(-0.55, -0.83));
          const ndl = std.max(0, std.dot(n, lightDir));
          const spec = std.pow(ndl, 24) * edge;
          col = std.add(col, std.mul(spec * 0.7, d.vec3f(0.95, 0.99, 1)));

          const rim =
            std.smoothstep(0.42, 0.52, density) *
            (1 - std.smoothstep(0.52, 0.75, density));
          col = std.add(col, std.mul(rim * 0.5, d.vec3f(0.75, 0.93, 1)));

          const shimmer =
            std.sin(world.x * 60 + uniR.time * 1.8) *
            std.sin(world.y * 48 - uniR.time * 1.3);
          col = std.add(col, std.mul(shimmer * 0.03 * depth, d.vec3f(0.6, 0.9, 1)));

          const alpha = mask * std.mix(0.8, 0.97, depth);
          const halo = std.smoothstep(0.08, 0.42, density) * (1 - mask) * 0.14 * inside;
          const waterA = std.min(1, alpha + halo);
          const waterRgb = std.add(
            std.mul(alpha, col),
            std.mul(halo, d.vec3f(0.45, 0.75, 1)),
          );

          const rgb = std.add(waterRgb, std.mul(1 - waterA, glassRgb));
          return d.vec4f(rgb, std.min(1, waterA + glassA * (1 - waterA)));
        },
      }),
    [root],
  );

  const { ref, ctxRef } = useConfigureContext({
    alphaMode: 'premultiplied',
    autoResize: false,
  });

  useFrame(({ elapsedSeconds }) => {
    const ctx = ctxRef.current;
    if (!ctx) {
      return;
    }

    const canvas = ctx.canvas as HTMLCanvasElement;
    const targetW = Math.max(
      1,
      Math.round(canvas.clientWidth * PixelRatio.get() * RESOLUTION_SCALE),
    );
    if (canvas.width !== targetW) {
      canvas.width = targetW;
      canvas.height = Math.max(
        1,
        Math.round(canvas.clientHeight * PixelRatio.get() * RESOLUTION_SCALE),
      );
    }
    const aspect = canvas.width / Math.max(1, canvas.height);
    const s = stateRef.current;
    const slow = slowmo();

    uni.write({
      gravity: d.vec2f(s.gravity.x * GRAVITY, s.gravity.y * GRAVITY),
      aspect,
      pump: s.pump,
      dt: DT / slow,
      time: elapsedSeconds / slow,
    });

    clearPipeline.with(computeGroup).dispatchThreads(NUM_SLOTS);
    binPipeline.with(computeGroup).dispatchThreads(N_PARTICLES);
    simPipeline.with(computeGroup).dispatchThreads(N_PARTICLES);

    renderPipeline
      .with(renderGroup)
      .withColorAttachment({ view: ctx })
      .draw(3);

    ctx.present?.();
  });

  return <Canvas ref={ref} style={style} transparent />;
}
