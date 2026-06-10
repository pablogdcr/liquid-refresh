import { useEffect, useMemo, useRef } from 'react';
import { Dimensions, StyleSheet, View } from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useFrameOutput,
} from 'react-native-vision-camera';
import { scheduleOnRN } from 'react-native-worklets';
import * as Haptics from 'expo-haptics';
import { DeviceMotion } from 'expo-sensors';
import {
  PondCanvas,
  REFLECTION_H,
  REFLECTION_W,
  type PondState,
} from './liquid/PondCanvas';

const { width: W, height: H } = Dimensions.get('window');

const captureSlowmo = () =>
  (globalThis as unknown as { __SLOWMO?: number }).__SLOWMO ?? 1;

// Fallback reflection for devices without a camera (the simulator):
// a quiet night sky — indigo gradient, a soft moon, a few stars. BGRA.
function makeNightSky(): Uint8Array {
  const buf = new Uint8Array(REFLECTION_W * REFLECTION_H * 4);
  for (let y = 0; y < REFLECTION_H; y++) {
    const t = y / REFLECTION_H;
    for (let x = 0; x < REFLECTION_W; x++) {
      const u = x / REFLECTION_W;
      const o = (y * REFLECTION_W + x) * 4;
      let r = 16 + 22 * (1 - t);
      let g = 20 + 30 * (1 - t);
      let b = 38 + 52 * (1 - t);
      // moon
      const dx = (u - 0.68) * 1.33;
      const dy = t - 0.28;
      const dd = Math.sqrt(dx * dx + dy * dy);
      const disc = Math.max(0, 1 - Math.max(0, dd - 0.035) / 0.02);
      const halo = Math.exp(-dd * dd * 90) * 0.35;
      const moon = Math.min(1, disc + halo);
      r += moon * 195;
      g += moon * 205;
      b += moon * 215;
      buf[o] = Math.min(255, b); // B
      buf[o + 1] = Math.min(255, g); // G
      buf[o + 2] = Math.min(255, r); // R
      buf[o + 3] = 255;
    }
  }
  // stars
  for (let i = 0; i < 90; i++) {
    const sx = Math.floor(((Math.sin(i * 127.1) * 0.5 + 0.5) % 1) * REFLECTION_W);
    const sy = Math.floor(((Math.sin(i * 311.7) * 0.5 + 0.5) % 1) * REFLECTION_H * 0.8);
    const o = (sy * REFLECTION_W + sx) * 4;
    const lum = 90 + ((i * 37) % 110);
    buf[o] = Math.min(255, buf[o] + lum);
    buf[o + 1] = Math.min(255, buf[o + 1] + lum);
    buf[o + 2] = Math.min(255, buf[o + 2] + lum);
  }
  return buf;
}

export function PondDemo() {
  const pond = useRef<PondState>({
    dropQueue: [],
    dimpleAmp: 0,
    dimpleX: 0.5,
    dimpleY: 0.5,
    light: { x: -0.45, y: -0.7 },
    uiRects: [],
    reflection: { data: null, dirty: false },
    reflectStrength: 0,
  });
  const lastTouch = useRef({ x: W / 2, y: H / 2 });

  // Reflection source: the front camera where available, otherwise the
  // generated night sky (the simulator has no camera).
  const camDevice = useCameraDevice('front');
  const { hasPermission, canRequestPermission, requestPermission } =
    useCameraPermission();

  useEffect(() => {
    pond.current.reflection = { data: makeNightSky(), dirty: true };
    pond.current.reflectStrength = 0.45;
    if (!hasPermission && canRequestPermission) {
      requestPermission();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // NOTE: declared before useFrameOutput — worklet closures snapshot
  // their captured values at creation time.
  const onReflectionFrame = (data: Uint8Array) => {
    pond.current.reflection.data = data;
    pond.current.reflection.dirty = true;
    pond.current.reflectStrength = 0.42;
  };

  const frameOutput = useFrameOutput({
    targetResolution: { width: REFLECTION_W, height: REFLECTION_H },
    pixelFormat: 'rgb',
    onFrame(frame) {
      'worklet';
      const g = globalThis as unknown as Record<string, number>;
      const now = Date.now();
      if ((g.__lastReflT ?? 0) + 80 > now) {
        frame.dispose();
        return;
      }
      g.__lastReflT = now;
      try {
        const plane = frame.getPlanes()[0];
        const src = new Uint8Array(plane.getPixelBuffer());
        const fw = plane.width;
        const fh = plane.height;
        const stride = plane.bytesPerRow;
        // Nearest-neighbor resize to the fixed reflection texture size.
        const out = new Uint8Array(REFLECTION_W * REFLECTION_H * 4);
        for (let y = 0; y < REFLECTION_H; y++) {
          const srow = Math.floor((y * fh) / REFLECTION_H) * stride;
          const orow = y * REFLECTION_W * 4;
          for (let x = 0; x < REFLECTION_W; x++) {
            const si = srow + Math.floor((x * fw) / REFLECTION_W) * 4;
            const oi = orow + x * 4;
            out[oi] = src[si];
            out[oi + 1] = src[si + 1];
            out[oi + 2] = src[si + 2];
            out[oi + 3] = 255;
          }
        }
        scheduleOnRN(onReflectionFrame, out);
      } finally {
        frame.dispose();
      }
    },
  });

  useEffect(() => {
    DeviceMotion.setUpdateInterval(50);
    const sub = DeviceMotion.addListener((m) => {
      const aig = m.accelerationIncludingGravity;
      if (!aig) {
        return;
      }
      // Top-down pond: tilting the device steers the light, not gravity.
      pond.current.light = {
        x: -0.45 - (aig.x / 9.81) * 0.8,
        y: -0.7 + (aig.y / 9.81) * 0.4,
      };
    });
    return () => sub.remove();
  }, []);

  const drop = (x: number, y: number, amp: number, radius: number) => {
    pond.current.dropQueue.push({ x, y, amp, radius });
  };

  // The lake breathes: a stray raindrop lands every few seconds.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      drop(
        0.25 + Math.random() * 0.5,
        0.2 + Math.random() * 0.6,
        0.08 + Math.random() * 0.12,
        4 + Math.random() * 3,
      );
      timer = setTimeout(tick, (3000 + Math.random() * 5000) * captureSlowmo());
    };
    timer = setTimeout(tick, 2500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The finger IS the rock: touching dents the surface, dragging trails
  // a wake, releasing splashes right where the finger was — strength
  // comes from the release velocity (set down gently vs flick).
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .maxPointers(1)
        .minDistance(0)
        .onBegin((e) => {
          pond.current.dimpleX = e.x / W;
          pond.current.dimpleY = e.y / H;
          pond.current.dimpleAmp = 0.4;
          lastTouch.current = { x: e.x, y: e.y };
        })
        .onUpdate((e) => {
          const dx = e.x - lastTouch.current.x;
          const dy = e.y - lastTouch.current.y;
          const dist = Math.hypot(dx, dy);

          pond.current.dimpleX = e.x / W;
          pond.current.dimpleY = e.y / H;

          // Wake: shed little ripples as the finger moves through.
          if (dist > 4) {
            drop(e.x / W, e.y / H, Math.min(0.22, 0.03 + dist * 0.01), 4);
            lastTouch.current = { x: e.x, y: e.y };
          }
        })
        .onFinalize((e) => {
          if (pond.current.dimpleAmp === 0) {
            return;
          }
          pond.current.dimpleAmp = 0;

          const fx = e.x / W;
          const fy = e.y / H;
          // Release speed in any direction: the "thrown from high" factor.
          const thrown = Math.min(
            1,
            Math.hypot(e.velocityX, e.velocityY) / 2400,
          );
          const amp = 0.2 + thrown * 1.0;
          drop(fx, fy, amp, 5 + thrown * 6);
          Haptics.impactAsync(
            amp > 0.85
              ? Haptics.ImpactFeedbackStyle.Heavy
              : Haptics.ImpactFeedbackStyle.Light,
          );

          // A hard throw splashes back: droplets chasing the first ring.
          const extras = Math.round(thrown * 4);
          for (let i = 1; i <= extras; i++) {
            setTimeout(() => {
              drop(
                fx + (Math.random() - 0.5) * 0.16,
                fy + (Math.random() - 0.5) * 0.1,
                amp * 0.3,
                5,
              );
              Haptics.selectionAsync();
            }, (90 + i * 110) * captureSlowmo());
          }
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (__DEV__) {
      // Capture rig — a few seconds of rain for recordings.
      (globalThis as Record<string, unknown>).__rain = (seconds = 3) => {
        const slow = captureSlowmo();
        const rain = setInterval(() => {
          drop(
            0.15 + Math.random() * 0.7,
            0.12 + Math.random() * 0.76,
            0.12 + Math.random() * 0.22,
            4.5 + Math.random() * 3,
          );
        }, 150 * slow);
        setTimeout(() => clearInterval(rain), seconds * 1000 * slow);
      };
    }
  });

  return (
    <GestureHandlerRootView style={styles.root}>
      <PondCanvas stateRef={pond} style={StyleSheet.absoluteFill} />
      {camDevice != null && hasPermission && (
        <Camera
          device={camDevice}
          isActive
          outputs={[frameOutput]}
          style={styles.camera}
        />
      )}
      <GestureDetector gesture={pan}>
        <View style={StyleSheet.absoluteFill} />
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0b0a08',
  },
  camera: {
    position: 'absolute',
    width: 1,
    height: 1,
    opacity: 0,
  },
});
