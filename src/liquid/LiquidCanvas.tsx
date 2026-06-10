import { useMemo, useRef, type RefObject } from 'react';
import { PixelRatio, type StyleProp, type ViewStyle } from 'react-native';
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

const SUBSTEPS = 1;
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
      time: 0,
      pour: 0,
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
          const uniR = renderLayout.$.uni;
          const world = d.vec2f(uv.x * uniR.aspect, uv.y);
          const density = sampleDensity(world);

          // Screen-space surface normal from the density gradient —
          // cheap derivatives instead of extra density taps.
          const grad = d.vec2f(std.dpdx(density), std.dpdy(density));
          const gradLen = std.max(std.length(grad), 1e-4);
          const n = std.mul(-1 / gradLen, grad);

          const mask = std.smoothstep(0.5, 0.74, density);
          // Saturates quickly so the particle lattice inside the body
          // doesn't show through as a dot pattern.
          const depth = std.smoothstep(0.58, 1.2, density);

          // Liquid glass body: ice cyan at the surface, rich blue core.
          const ice = d.vec3f(0.5, 0.8, 1.0);
          const deepBlue = d.vec3f(0.06, 0.3, 0.68);
          const abyss = d.vec3f(0.02, 0.12, 0.36);
          let col = std.mix(ice, deepBlue, depth);

          // Vertical depth gradient toward the floor — masks any leftover
          // interior texture and reads as real water depth.
          const vd = std.smoothstep(uniR.floorY - 0.55, uniR.floorY, world.y);
          col = std.mix(col, abyss, vd * 0.45);

          // Crisp specular from a top-left light — gated to real surface
          // edges (large gradient + low density), so the interior stays
          // calm instead of sparkling like foam.
          const edge =
            std.smoothstep(0.015, 0.05, gradLen) *
            (1 - std.smoothstep(0.8, 1.0, density));
          const lightDir = std.normalize(d.vec2f(-0.55, -0.83));
          const ndl = std.max(0, std.dot(n, lightDir));
          const spec = std.pow(ndl, 24) * edge;
          col = std.add(col, std.mul(spec * 0.7, d.vec3f(0.95, 0.99, 1)));

          // Thin bright rim hugging the surface.
          const rim =
            std.smoothstep(0.5, 0.58, density) *
            (1 - std.smoothstep(0.58, 0.78, density));
          col = std.add(col, std.mul(rim * 0.5, d.vec3f(0.75, 0.93, 1)));

          // Subtle internal shimmer so the body never reads as flat.
          const shimmer =
            std.sin(world.x * 26 + uniR.time * 1.8) *
            std.sin(world.y * 21 - uniR.time * 1.3);
          col = std.add(col, std.mul(shimmer * 0.035 * depth, d.vec3f(0.6, 0.9, 1)));

          // Glassy translucency: shallow water lets the background through.
          const alpha = mask * std.mix(0.78, 0.97, depth);

          // Soft cyan halo around droplets and the surface.
          const halo = std.smoothstep(0.1, 0.5, density) * (1 - mask) * 0.16;
          const waterA = std.min(1, alpha + halo);
          const waterRgb = std.add(
            std.mul(alpha, col),
            std.mul(halo, d.vec3f(0.45, 0.75, 1)),
          );

          // Scene behind the water: a faint aquarium glow falling from the
          // top, plus a light beam under the Dynamic Island while pouring.
          const dxI = world.x - uniR.aspect * 0.5;
          const beam =
            std.exp(-dxI * dxI * 14) *
            std.max(0, 1 - world.y * 1.1) *
            uniR.pour;
          const ambient = std.max(0, 1 - world.y * 1.4) * 0.06;
          const bgA = std.min(0.5, ambient + beam * 0.3);
          const bgRgb = std.mul(bgA, d.vec3f(0.4, 0.65, 0.95));

          const rgb = std.add(waterRgb, std.mul(1 - waterA, bgRgb));
          return d.vec4f(rgb, std.min(1, waterA + bgA * (1 - waterA)));
        },
      }),
    [root],
  );

  const { ref, ctxRef } = useConfigureContext({
    alphaMode: 'premultiplied',
    autoResize: false,
  });
  const smoothFill = useRef(0);

  useFrame(({ deltaSeconds, elapsedSeconds }) => {
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

    // Ease the active particle count toward the target so water pours in
    // instead of appearing all at once.
    smoothFill.current +=
      (s.fill - smoothFill.current) * Math.min(1, (deltaSeconds * 6) / slow);
    if (s.fill === 0 && smoothFill.current < 0.01) {
      smoothFill.current = 0;
    } else if (Math.abs(s.fill - smoothFill.current) < 0.005) {
      smoothFill.current = s.fill;
    }

    // Pour intensity: how far the eased fill is lagging behind the target.
    const pour = Math.min(1, Math.max(0, (s.fill - smoothFill.current) * 14));

    uni.write({
      gravity: d.vec2f(s.gravity.x * GRAVITY, s.gravity.y * GRAVITY),
      aspect,
      activeCount: Math.round(smoothFill.current * N_PARTICLES),
      drainOpen: s.drainOpen ? 1 : 0,
      floorY: Math.max(0.05, Math.min(1, s.floor)),
      dt: DT / slow,
      time: elapsedSeconds / slow,
      pour,
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
