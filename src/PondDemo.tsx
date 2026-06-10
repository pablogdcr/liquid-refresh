import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  type LayoutChangeEvent,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
} from 'react-native-gesture-handler';
import * as Haptics from 'expo-haptics';
import { DeviceMotion } from 'expo-sensors';
import { PondCanvas, type PondState, type UiRectSpec } from './liquid/PondCanvas';
import { GH, GW } from './liquid/sim';

const { width: W, height: H } = Dimensions.get('window');
const HEADER_TOP = H * 0.11;
// pt -> grid cell scale (cells are square)
const SX = GW / W;
const SY = GH / H;
// Water laps a few points past each element's true bounds.
const RECT_INFLATE = 4;

const TRIGGER_PULL = 120;
// Where the "rock" lands, in normalized screen coords.
const DROP_X = 0.5;
const DROP_Y = 0.42;

const captureSlowmo = () =>
  (globalThis as unknown as { __SLOWMO?: number }).__SLOWMO ?? 1;

interface CardSpec {
  top: number;
  left: number;
  width: number;
  title: string;
  body: string;
  big?: boolean;
}

const CARDS: CardSpec[] = [
  {
    top: H * 0.3,
    left: 28,
    width: W - 100,
    title: '“Be like water, my friend.”',
    body: 'Bruce Lee',
    big: true,
  },
  {
    top: H * 0.47,
    left: 52,
    width: W * 0.44,
    title: '1,208',
    body: 'breaths today',
  },
  {
    top: H * 0.47 + 26,
    left: 52 + W * 0.44 + 18,
    width: W * 0.34,
    title: '21 days',
    body: 'still streak',
  },
  {
    top: H * 0.63,
    left: 36,
    width: W * 0.56,
    title: '4 min',
    body: 'until your evening sit',
  },
];

// Two probes per card (left/right edges) -> bob + tilt.
const PROBES = CARDS.flatMap((c) => [
  { x: (c.left + 16) / W, y: (c.top + 36) / H },
  { x: (c.left + c.width - 16) / W, y: (c.top + 36) / H },
]);

export function PondDemo() {
  const pond = useRef<PondState>({
    dropQueue: [],
    dimpleAmp: 0,
    dimpleX: DROP_X,
    dimpleY: DROP_Y,
    light: { x: -0.45, y: -0.7 },
    uiRects: [],
  });
  const rectBases = useRef(
    new Map<string, { x: number; y: number; w: number; h: number; r: number }>(),
  );
  const cardLifts = useRef<number[]>(CARDS.map(() => 0));

  const rebuildRects = () => {
    const out: UiRectSpec[] = [];
    rectBases.current.forEach((v, key) => {
      const lift = key.startsWith('card')
        ? (cardLifts.current[Number(key.slice(4))] ?? 0)
        : 0;
      out.push({
        cx: (v.x + v.w / 2) * SX,
        cy: (v.y + lift + v.h / 2) * SY,
        hw: (v.w / 2 + RECT_INFLATE) * SX,
        hh: (v.h / 2 + RECT_INFLATE) * SY,
        r: (v.r + RECT_INFLATE) * SX,
      });
    });
    pond.current.uiRects = out;
  };

  const measureRect =
    (key: string, r: number, offsetY = 0) =>
    (e: LayoutChangeEvent) => {
      const { x, y, width, height } = e.nativeEvent.layout;
      rectBases.current.set(key, { x, y: y + offsetY, w: width, h: height, r });
      rebuildRects();
    };
  const refreshingRef = useRef(false);
  const lastTick = useRef(0);
  const lastTouch = useRef({ x: DROP_X * W, y: DROP_Y * H });
  const [status, setStatus] = useState<'idle' | 'raining' | 'done'>('idle');
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  const bobValues = useMemo(
    () =>
      CARDS.map(() => ({
        y: new Animated.Value(0),
        rot: new Animated.Value(0),
      })),
    [],
  );

  useEffect(() => {
    DeviceMotion.setUpdateInterval(50);
    const sub = DeviceMotion.addListener((m) => {
      const aig = m.accelerationIncludingGravity;
      if (!aig) {
        return;
      }
      // Top-down pond: tilting the phone steers the light, not gravity.
      pond.current.light = {
        x: -0.45 - (aig.x / 9.81) * 0.8,
        y: -0.7 + (aig.y / 9.81) * 0.4,
      };
    });
    return () => sub.remove();
  }, []);

  const onWave = (heights: number[]) => {
    for (let i = 0; i < CARDS.length; i++) {
      const hl = heights[i * 2] ?? 0;
      const hr = heights[i * 2 + 1] ?? 0;
      const lift = Math.max(-1, Math.min(1, (hl + hr) * 2.2));
      const tilt = Math.max(-1, Math.min(1, (hr - hl) * 3));
      cardLifts.current[i] = lift * -5;
      bobValues[i].y.setValue(lift * -5);
      bobValues[i].rot.setValue(tilt * 1.6);
    }
    rebuildRects();
  };

  const drop = (x: number, y: number, amp: number, radius: number) => {
    pond.current.dropQueue.push({ x, y, amp, radius });
  };

  // NOTE: must be declared BEFORE the pan gesture below — the worklets
  // Babel plugin snapshots gesture-callback closures at creation time,
  // so anything referenced inside must already be initialized.
  const startRefresh = () => {
    refreshingRef.current = true;
    setStatus('raining');

    // While "fetching": soft rain across the pond.
    const slow = captureSlowmo();
    const rain = setInterval(() => {
      drop(
        0.08 + Math.random() * 0.84,
        0.06 + Math.random() * 0.88,
        0.12 + Math.random() * 0.22,
        4.5 + Math.random() * 3,
      );
    }, 150 * slow);

    setTimeout(() => {
      clearInterval(rain);
      // One last big ring: the "done" signal.
      drop(DROP_X, DROP_Y, 1.1, 9);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLastRefresh(
        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      );
      setStatus('done');
      refreshingRef.current = false;
    }, 3400 * slow);
  };

  // The finger IS the rock: touching dents the surface, dragging trails
  // a wake, releasing drops the splash right where the finger was.
  const pan = useMemo(
    () =>
      Gesture.Pan()
        .runOnJS(true)
        .maxPointers(1)
        .minDistance(0)
        .onBegin((e) => {
          pond.current.dimpleX = e.x / W;
          pond.current.dimpleY = e.y / H;
          pond.current.dimpleAmp = 0.35;
          lastTouch.current = { x: e.x, y: e.y };
        })
        .onUpdate((e) => {
          const dx = e.x - lastTouch.current.x;
          const dy = e.y - lastTouch.current.y;
          const dist = Math.hypot(dx, dy);

          pond.current.dimpleX = e.x / W;
          pond.current.dimpleY = e.y / H;
          const pullProg = refreshingRef.current
            ? 0
            : Math.min(1, Math.max(0, e.translationY) / TRIGGER_PULL);
          pond.current.dimpleAmp = 0.35 + pullProg * 0.45;

          // Wake: shed little ripples as the finger moves through.
          if (dist > 4) {
            drop(e.x / W, e.y / H, Math.min(0.22, 0.03 + dist * 0.01), 4);
            lastTouch.current = { x: e.x, y: e.y };
          }

          const tick = Math.floor(pullProg * 4);
          if (!refreshingRef.current && tick !== lastTick.current) {
            lastTick.current = tick;
            if (tick > 0) {
              Haptics.selectionAsync();
            }
          }
        })
        .onFinalize((e) => {
          if (pond.current.dimpleAmp === 0) {
            return;
          }
          pond.current.dimpleAmp = 0;

          const fx = e.x / W;
          const fy = e.y / H;
          const pull = Math.max(0, e.translationY);
          const strength = Math.min(1, pull / TRIGGER_PULL);
          // velocityY is pt/s at release: the "thrown from high" factor.
          const thrown = Math.min(1, Math.max(0, e.velocityY) / 2400);
          const amp = 0.18 + strength * 0.7 + thrown * 0.7;
          drop(fx, fy, amp, 5 + strength * 5 + thrown * 3);
          Haptics.impactAsync(
            amp > 0.9
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

          if (!refreshingRef.current && pull >= TRIGGER_PULL) {
            startRefresh();
          }
        }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (__DEV__) {
      // Capture rig — trigger the full cycle without a gesture.
      (globalThis as Record<string, unknown>).__startRefresh = () => {
        pond.current.dropQueue.push({ x: DROP_X, y: DROP_Y, amp: 1.2, radius: 8 });
        startRefresh();
      };
    }
  });

  const statusLabel =
    status === 'raining'
      ? 'rain…'
      : lastRefresh
        ? `still again · ${lastRefresh}`
        : 'pull to drop';

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.header} pointerEvents="none">
        <View
          style={styles.titlePlaque}
          onLayout={measureRect('title', 22, HEADER_TOP)}
        >
          <Text style={styles.title}>still.</Text>
        </View>
        <View
          style={styles.statusPill}
          onLayout={measureRect('pill', 14, HEADER_TOP)}
        >
          <View
            style={[
              styles.statusDot,
              status === 'raining' && styles.statusDotActive,
            ]}
          />
          <Text style={styles.statusText}>{statusLabel}</Text>
        </View>
      </View>

      {CARDS.map((c, i) => (
        <Animated.View
          key={c.title}
          pointerEvents="none"
          onLayout={measureRect(`card${i}`, 20)}
          style={[
            styles.card,
            {
              top: c.top,
              left: c.left,
              width: c.width,
              transform: [
                { translateY: bobValues[i].y },
                {
                  rotate: bobValues[i].rot.interpolate({
                    inputRange: [-2, 2],
                    outputRange: ['-2deg', '2deg'],
                  }),
                },
              ],
            },
          ]}
        >
          <Text style={[styles.cardTitle, c.big && styles.cardTitleBig]}>
            {c.title}
          </Text>
          <Text style={styles.cardBody}>{c.body}</Text>
        </Animated.View>
      ))}

      <View
        style={styles.footerPlaque}
        pointerEvents="none"
        onLayout={measureRect('footer', 11)}
      >
        <Text style={styles.footer}>
          a GPU pond · shaders written in TypeScript · typegpu
        </Text>
      </View>

      {/* The water surface renders ABOVE the UI — content sits under it. */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <PondCanvas
          stateRef={pond}
          probes={PROBES}
          onWave={onWave}
          style={StyleSheet.absoluteFill}
        />
      </View>

      {/* Touch layer: the finger interacts directly with the water. */}
      <GestureDetector gesture={pan}>
        <View style={StyleSheet.absoluteFill} />
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#03050a',
  },
  header: {
    position: 'absolute',
    top: H * 0.11,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  titlePlaque: {
    backgroundColor: 'rgba(8, 14, 24, 0.6)',
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(159, 216, 255, 0.14)',
    paddingHorizontal: 24,
    paddingVertical: 2,
  },
  title: {
    color: '#eef4fc',
    fontSize: 44,
    fontFamily: 'Georgia',
    fontStyle: 'italic',
    letterSpacing: 1,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(159, 216, 255, 0.22)',
    backgroundColor: 'rgba(5, 10, 18, 0.45)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    gap: 7,
    marginTop: 10,
  },
  statusDot: {
    width: 5,
    height: 5,
    borderRadius: 3,
    backgroundColor: '#6fb6e8',
  },
  statusDotActive: {
    backgroundColor: '#8fd6ff',
  },
  statusText: {
    color: '#8aa3c2',
    fontSize: 12,
    letterSpacing: 0.4,
  },
  card: {
    position: 'absolute',
    backgroundColor: 'rgba(10, 17, 30, 0.55)',
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(159, 216, 255, 0.14)',
    paddingHorizontal: 18,
    paddingVertical: 14,
  },
  cardTitle: {
    color: '#e7eefb',
    fontSize: 20,
    fontWeight: '600',
    letterSpacing: -0.3,
  },
  cardTitleBig: {
    fontFamily: 'Georgia',
    fontStyle: 'italic',
    fontWeight: '400',
    fontSize: 19,
    lineHeight: 26,
  },
  cardBody: {
    color: '#5f7390',
    fontSize: 13,
    marginTop: 3,
  },
  footerPlaque: {
    position: 'absolute',
    bottom: 30,
    alignSelf: 'center',
    backgroundColor: 'rgba(8, 14, 24, 0.55)',
    borderRadius: 11,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  footer: {
    color: '#3b4d6b',
    fontSize: 11,
    letterSpacing: 0.4,
  },
});
