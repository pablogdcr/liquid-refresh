import { useMemo, useRef, type RefObject } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Canvas } from 'react-native-wgpu';
import { common, d, std } from 'typegpu';
import {
  useBindGroup,
  useConfigureContext,
  useFrame,
  useMutable,
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
  renderLayout,
  sampleDensity,
  simulate,
  SimUniforms,
} from './sim';

export interface LiquidState {
  /** 0..1 — fraction of the water volume that should be in the container. */
  fill: number;
  /** 0..1 — where the floor of the container sits, as a fraction of canvas height. */
  floor: number;
  /** When true the floor opens and the water drains out of view. */
  drainOpen: boolean;
  /** Unit-ish gravity direction in canvas space (x right, y down). */
  gravity: { x: number; y: number };
}

interface LiquidCanvasProps {
  stateRef: RefObject<LiquidState>;
  style?: StyleProp<ViewStyle>;
}

const SUBSTEPS = 2;
const DT = 1 / 120;

export function LiquidCanvas({ stateRef, style }: LiquidCanvasProps) {
  const root = useRoot();

  const particles = useMutable(d.arrayOf(Particle, N_PARTICLES));
  const counts = useMutable(d.arrayOf(d.atomic(d.u32), NUM_CELLS));
  const slots = useMutable(d.arrayOf(d.u32, NUM_SLOTS));
  const uni = useUniform(SimUniforms, {
    initial: {
      gravity: d.vec2f(0, GRAVITY),
      aspect: 1,
      activeCount: 0,
      drainOpen: 0,
      floorY: 1,
      dt: DT,
    },
  });

  const computeGroup = useBindGroup(computeLayout, {
    uni: uni.buffer,
    particles: particles.buffer,
    counts: counts.buffer,
    slots: slots.buffer,
  });
  const renderGroup = useBindGroup(renderLayout, {
    uni: uni.buffer,
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
          const aspect = renderLayout.$.uni.aspect;
          const world = d.vec2f(uv.x * aspect, uv.y);
          const density = sampleDensity(world);

          const water = std.smoothstep(0.55, 0.8, density);
          const deep = d.vec3f(0.02, 0.35, 0.72);
          const shallow = d.vec3f(0.3, 0.72, 0.98);
          const body = std.mix(shallow, deep, std.clamp(density - 0.8, 0, 1));
          const foam =
            std.smoothstep(0.55, 0.7, density) *
            (1 - std.smoothstep(0.9, 1.3, density));
          const col = std.add(body, std.mul(foam * 0.35, d.vec3f(0.9, 0.95, 1)));
          const alpha = water * 0.92;
          return d.vec4f(std.mul(alpha, col), alpha);
        },
      }),
    [root],
  );

  const { ref, ctxRef } = useConfigureContext({ alphaMode: 'premultiplied' });
  const smoothFill = useRef(0);

  useFrame(({ deltaSeconds }) => {
    const ctx = ctxRef.current;
    if (!ctx) {
      return;
    }

    const canvas = ctx.canvas as HTMLCanvasElement;
    const aspect = canvas.width / Math.max(1, canvas.height);
    const s = stateRef.current;

    // Ease the active particle count toward the target so water pours in
    // instead of appearing all at once.
    smoothFill.current += (s.fill - smoothFill.current) * Math.min(1, deltaSeconds * 6);
    if (s.fill === 0 && smoothFill.current < 0.01) {
      smoothFill.current = 0;
    } else if (Math.abs(s.fill - smoothFill.current) < 0.005) {
      smoothFill.current = s.fill;
    }

    uni.write({
      gravity: d.vec2f(s.gravity.x * GRAVITY, s.gravity.y * GRAVITY),
      aspect,
      activeCount: Math.round(smoothFill.current * N_PARTICLES),
      drainOpen: s.drainOpen ? 1 : 0,
      floorY: Math.max(0.05, Math.min(1, s.floor)),
      dt: DT,
    });

    for (let i = 0; i < SUBSTEPS; i++) {
      clearPipeline.with(computeGroup).dispatchThreads(NUM_SLOTS);
      binPipeline.with(computeGroup).dispatchThreads(N_PARTICLES);
      simPipeline.with(computeGroup).dispatchThreads(N_PARTICLES);
    }

    renderPipeline
      .with(renderGroup)
      .withColorAttachment({ view: ctx })
      .draw(3);

    ctx.present?.();
  });

  return <Canvas ref={ref} style={style} transparent />;
}
