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
  computeLayout,
  DropArray,
  GH,
  GW,
  heightBilinear,
  lakeSdf,
  MAX_DROPS,
  MAX_PROBES,
  MAX_RECTS,
  NUM_CELLS,
  ProbeOut,
  ProbePoints,
  probeLayout,
  readProbes,
  RectArray,
  renderLayout,
  SimUniforms,
  uiMask,
  updateField,
} from './sim';

export interface DropRequest {
  /** normalized screen coords (0..1) */
  x: number;
  y: number;
  /** impulse strength, ~0.1 (drizzle) .. 1.6 (thrown rock) */
  amp: number;
  /** ring sharpness in grid cells, ~4 (sharp) .. 14 (broad) */
  radius: number;
}

export interface UiRectSpec {
  /** all in grid coordinates */
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  r: number;
}

export interface PondState {
  /** Drops to inject — consumed (cleared) by the canvas each frame. */
  dropQueue: DropRequest[];
  /** The held "rock": 0..1 while pulling, 0 when released. */
  dimpleAmp: number;
  dimpleX: number;
  dimpleY: number;
  /** Unit-ish light direction (tilt-driven on device). */
  light: { x: number; y: number };
  /** UI elements the water flows over (translucent there). */
  uiRects: UiRectSpec[];
  /** What the water mirrors (camera frame or generated sky), BGRA bytes
   * at REFLECTION_W x REFLECTION_H. Set dirty after writing new data. */
  reflection: { data: Uint8Array | null; dirty: boolean };
  /** 0..1 — how visible the reflection is. */
  reflectStrength: number;
}

export const REFLECTION_W = 640;
export const REFLECTION_H = 480;

interface PondCanvasProps {
  stateRef: RefObject<PondState>;
  /** Normalized screen positions whose wave height is reported back. */
  probes?: ReadonlyArray<{ x: number; y: number }>;
  /** Called with one height per probe, a few times per second. */
  onWave?: (heights: number[]) => void;
  style?: StyleProp<ViewStyle>;
}

const RESOLUTION_SCALE = 0.5;
const WAVE_K = 0.3;
const DAMP_V = 0.9925;

// Capture rig: the iOS simulator throttles canvas presents to ~15fps no
// matter the workload. Setting `globalThis.__SLOWMO = 4` slows the wave
// integration — record, then speed the video 4x for a smooth 60fps clip.
const slowmo = () =>
  (globalThis as unknown as { __SLOWMO?: number }).__SLOWMO ?? 1;

export function PondCanvas({
  stateRef,
  probes = [],
  onWave,
  style,
}: PondCanvasProps) {
  const root = useRoot();

  // Explicit zero-init: the RN WebGPU runtime hands out buffers with
  // garbage contents, so a wave field must start flat by hand.
  const hA = useMutable(d.arrayOf(d.f32, NUM_CELLS), {
    initial: new Array<number>(NUM_CELLS).fill(0),
  });
  const hB = useMutable(d.arrayOf(d.f32, NUM_CELLS), {
    initial: new Array<number>(NUM_CELLS).fill(0),
  });
  const vel = useMutable(d.arrayOf(d.f32, NUM_CELLS), {
    initial: new Array<number>(NUM_CELLS).fill(0),
  });
  const probeOut = useMutable(ProbeOut, {
    initial: new Array<number>(MAX_PROBES).fill(0),
  });
  const probePts = useUniform(ProbePoints, {
    initial: Array.from({ length: MAX_PROBES }, (_, i) => {
      const p = probes[i] ?? { x: 0.5, y: 0.5 };
      return d.vec2f(p.x, p.y);
    }),
  });
  const drops = useUniform(DropArray, {
    initial: Array.from({ length: MAX_DROPS }, () => ({
      pos: d.vec2f(0, 0),
      amp: 0,
      radius: 1,
    })),
  });
  const rects = useUniform(RectArray, {
    initial: Array.from({ length: MAX_RECTS }, () => ({
      center: d.vec2f(0, 0),
      half: d.vec2f(0, 0),
      r: 0,
    })),
  });
  const reflTex = useMemo(
    () =>
      root
        .createTexture({
          size: [REFLECTION_W, REFLECTION_H],
          format: 'bgra8unorm',
        })
        .$usage('sampled'),
    [root],
  );
  const reflSampler = useMemo(
    () =>
      root['~unstable'].createSampler({
        magFilter: 'linear',
        minFilter: 'linear',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge',
      }),
    [root],
  );
  const uni = useUniform(SimUniforms, {
    initial: {
      k: WAVE_K,
      dampV: DAMP_V,
      dropCount: 0,
      dimple: d.vec4f(0, 0, 0, 1),
      lightDir: d.vec2f(-0.45, -0.7),
      time: 0,
      reflect: 0,
    },
  });

  const computeAB = useBindGroup(computeLayout, {
    uni: uni.buffer,
    drops: drops.buffer,
    hSrc: hA.buffer,
    hDst: hB.buffer,
    vel: vel.buffer,
  });
  const computeBA = useBindGroup(computeLayout, {
    uni: uni.buffer,
    drops: drops.buffer,
    hSrc: hB.buffer,
    hDst: hA.buffer,
    vel: vel.buffer,
  });
  const renderA = useBindGroup(renderLayout, {
    uni: uni.buffer,
    h: hA.buffer,
    rects: rects.buffer,
    reflection: reflTex,
    samp: reflSampler,
  });
  const renderB = useBindGroup(renderLayout, {
    uni: uni.buffer,
    h: hB.buffer,
    rects: rects.buffer,
    reflection: reflTex,
    samp: reflSampler,
  });
  const probeA = useBindGroup(probeLayout, {
    h: hA.buffer,
    pts: probePts.buffer,
    out: probeOut.buffer,
  });
  const probeB = useBindGroup(probeLayout, {
    h: hB.buffer,
    pts: probePts.buffer,
    out: probeOut.buffer,
  });

  const updatePipeline = useMemo(
    () => root.createGuardedComputePipeline(updateField),
    [root],
  );
  const probePipeline = useMemo(
    () => root.createGuardedComputePipeline(readProbes),
    [root],
  );

  const renderPipeline = useMemo(
    () =>
      root.createRenderPipeline({
        vertex: common.fullScreenTriangle,
        fragment: ({ uv }) => {
          'use gpu';
          const uniR = renderLayout.$.uni;
          const px = uv.x * GW;
          const py = uv.y * GH;
          const pg = d.vec2f(px, py);

          const hL = heightBilinear(px - 1.5, py);
          const hR = heightBilinear(px + 1.5, py);
          const hU = heightBilinear(px, py - 1.5);
          const hD = heightBilinear(px, py + 1.5);
          const hC = heightBilinear(px, py);

          // Surface normal from the height gradient.
          const n = std.normalize(d.vec3f((hL - hR) * 9, (hU - hD) * 9, 1));

          const sdL = lakeSdf(pg);
          const inLake = std.smoothstep(0.6, -1.4, sdL);

          const vign =
            1 -
            0.5 *
              std.smoothstep(
                0.12,
                0.85,
                std.length(d.vec2f(uv.x - 0.5, uv.y - 0.45)),
              );

          // ---- Shore: warm dark sand with fine grain and a wet band.
          const grain = std.fract(
            std.sin(
              std.dot(std.floor(std.mul(1.9, pg)), d.vec2f(12.9898, 78.233)),
            ) * 43758.547,
          );
          let shore = std.mix(
            d.vec3f(0.062, 0.055, 0.046),
            d.vec3f(0.096, 0.085, 0.069),
            grain * 0.35 + uv.y * 0.25,
          );
          shore = std.mul(vign, shore);
          // Wet sand right at the waterline.
          const wet = std.smoothstep(7, 0.5, sdL);
          shore = std.mul(std.mix(1, 0.6, wet * (1 - inLake)), shore);

          // ---- Water: refracted floor, caustics, crests, glints.
          const ruv = d.vec2f(uv.x + n.x * 0.08, uv.y + n.y * 0.08);
          let water = std.mul(
            vign,
            std.mix(
              d.vec3f(0.022, 0.066, 0.105),
              d.vec3f(0.008, 0.026, 0.046),
              ruv.y,
            ),
          );

          const ca =
            std.sin(ruv.x * 21 + uniR.time * 0.35) *
            std.sin(ruv.y * 17 - uniR.time * 0.27);
          const cb =
            std.sin(ruv.x * 9 - uniR.time * 0.2) *
            std.sin(ruv.y * 7 + uniR.time * 0.16);
          water = std.add(
            water,
            std.mul(
              std.max(0, ca * cb) * 0.035 * vign,
              d.vec3f(0.35, 0.75, 0.7),
            ),
          );

          // The reflection (front camera / sky), warped by the waves.
          // Mirrored x like a real reflection; wave normals displace it.
          const cuv = d.vec2f(
            std.clamp(1 - uv.x + n.x * 0.35, 0.005, 0.995),
            std.clamp(uv.y + n.y * 0.35, 0.005, 0.995),
          );
          const refl = std.textureSample(
            renderLayout.$.reflection,
            renderLayout.$.samp,
            cuv,
          );
          const reflCol = std.mul(
            d.vec3f(refl.x, refl.y, refl.z),
            d.vec3f(0.5, 0.58, 0.7),
          );
          water = std.mix(water, reflCol, uniR.reflect);

          // Shallows: the bank shows through near the waterline.
          const shallow = std.smoothstep(-9, -0.5, sdL);
          water = std.mix(water, std.mul(1.7, shore), shallow * 0.4);

          const curv = hL + hR + hU + hD - 4 * hC;
          const crest = std.clamp(-curv * 30, 0, 1);
          water = std.add(water, std.mul(crest * 0.085, d.vec3f(0.55, 0.8, 1)));

          const lightV = std.normalize(
            d.vec3f(uniR.lightDir.x, uniR.lightDir.y, 0.85),
          );
          const half = std.normalize(std.add(lightV, d.vec3f(0, 0, 1)));
          const spec = std.pow(std.max(0, std.dot(n, half)), 90);
          water = std.add(water, std.mul(spec * 0.55, d.vec3f(0.85, 0.95, 1)));

          // ---- Compose: shore outside, water inside, glint at the line.
          let col = std.mix(shore, water, inLake);
          const lineGlint = std.smoothstep(1.8, 0.2, std.abs(sdL));
          col = std.add(col, std.mul(lineGlint * 0.05, d.vec3f(0.7, 0.88, 1)));

          // Over UI elements the surface turns translucent: only the
          // water's light (glints, crests) and trough shadows render,
          // so the content reads through like stones under the surface.
          const ui = uiMask(pg);
          const trough = std.clamp(-hC * 1.8, 0, 0.35);
          const overlayRgb = std.add(
            std.mul(spec * 0.55, d.vec3f(0.85, 0.95, 1)),
            std.mul(crest * 0.1, d.vec3f(0.55, 0.8, 1)),
          );
          const overlayA = std.clamp(
            spec * 0.6 + crest * 0.3 + trough,
            0,
            0.85,
          );

          const rgb = std.mix(col, overlayRgb, ui);
          return d.vec4f(rgb, std.mix(1, overlayA, ui));
        },
      }),
    [root],
  );

  const { ref, ctxRef } = useConfigureContext({
    alphaMode: 'opaque',
    autoResize: false,
  });
  const parity = useRef(0);
  const frame = useRef(0);
  const probeBusy = useRef(false);

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

    const s = stateRef.current;
    const slow = slowmo();
    frame.current++;

    // Fresh reflection frame (camera or generated sky)?
    if (s.reflection.dirty && s.reflection.data) {
      reflTex.write(s.reflection.data);
      s.reflection.dirty = false;
    }

    // Feed queued drops to the GPU (up to MAX_DROPS per frame).
    const batch = s.dropQueue.splice(0, MAX_DROPS);
    if (batch.length > 0) {
      drops.write(
        Array.from({ length: MAX_DROPS }, (_, i) => {
          const q = batch[i];
          return q
            ? {
                pos: d.vec2f(q.x * GW, q.y * GH),
                amp: q.amp / slow,
                radius: q.radius,
              }
            : { pos: d.vec2f(0, 0), amp: 0, radius: 1 };
        }),
      );
    }

    rects.write(
      Array.from({ length: MAX_RECTS }, (_, i) => {
        const rc = s.uiRects[i];
        return rc
          ? {
              center: d.vec2f(rc.cx, rc.cy),
              half: d.vec2f(rc.hw, rc.hh),
              r: rc.r,
            }
          : { center: d.vec2f(0, 0), half: d.vec2f(0, 0), r: 0 };
      }),
    );

    uni.write({
      // wave speed goes with sqrt(k): slow-mo needs k / slow^2
      k: WAVE_K / (slow * slow),
      dampV: 1 - (1 - DAMP_V) / slow,
      dropCount: batch.length,
      dimple: d.vec4f(
        s.dimpleX * GW,
        s.dimpleY * GH,
        s.dimpleAmp * 0.55,
        6 + s.dimpleAmp * 16,
      ),
      lightDir: d.vec2f(s.light.x, s.light.y),
      time: elapsedSeconds / slow,
      reflect: s.reflectStrength,
    });

    const useAB = parity.current === 0;
    parity.current ^= 1;

    updatePipeline.with(useAB ? computeAB : computeBA).dispatchThreads(NUM_CELLS);

    if (onWave && frame.current % 3 === 0 && !probeBusy.current) {
      probeBusy.current = true;
      probePipeline.with(useAB ? probeB : probeA).dispatchThreads(MAX_PROBES);
      probeOut
        .read()
        .then((heights) => {
          probeBusy.current = false;
          onWave(heights as number[]);
        })
        .catch(() => {
          probeBusy.current = false;
        });
    }

    renderPipeline
      .with(useAB ? renderB : renderA)
      .withColorAttachment({ view: ctx })
      .draw(3);

    ctx.present?.();
  });

  return <Canvas ref={ref} style={style} />;
}
