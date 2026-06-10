import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Dimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { DeviceMotion } from 'expo-sensors';
import { PondCanvas, type PondState } from './liquid/PondCanvas';

const { width: W, height: H } = Dimensions.get('window');

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
  });
  const refreshingRef = useRef(false);
  const lastTick = useRef(0);
  const maxPullSpeed = useRef(0);
  const lastPull = useRef({ value: 0, t: 0 });
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
      bobValues[i].y.setValue(lift * -5);
      bobValues[i].rot.setValue(tilt * 1.6);
    }
  };

  const drop = (x: number, y: number, amp: number, radius: number) => {
    pond.current.dropQueue.push({ x, y, amp, radius });
  };

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (refreshingRef.current) {
      return;
    }
    const pull = Math.max(0, -e.nativeEvent.contentOffset.y);
    const progress = Math.min(1, pull / TRIGGER_PULL);

    const now = Date.now();
    const dt = now - lastPull.current.t;
    if (dt > 0 && dt < 200) {
      const speed = (pull - lastPull.current.value) / dt; // pt per ms
      if (speed > maxPullSpeed.current) {
        maxPullSpeed.current = speed;
      }
    }
    lastPull.current = { value: pull, t: now };

    pond.current.dimpleAmp = progress;

    const tick = Math.floor(progress * 4);
    if (tick !== lastTick.current) {
      lastTick.current = tick;
      if (tick > 0) {
        Haptics.selectionAsync();
      }
    }
  };

  const onRelease = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (refreshingRef.current) {
      return;
    }
    const pull = Math.max(0, -e.nativeEvent.contentOffset.y);
    const strength = Math.min(1, pull / TRIGGER_PULL);
    const speed = maxPullSpeed.current;
    maxPullSpeed.current = 0;
    pond.current.dimpleAmp = 0;

    if (strength < 0.08) {
      return;
    }

    // The rock lands: gentle set-down vs full throw.
    const thrown = Math.min(1, speed / 2.2);
    const amp = 0.25 + strength * 0.7 + thrown * 0.6;
    drop(DROP_X, DROP_Y, amp, 7 + strength * 6);
    Haptics.impactAsync(
      amp > 0.9
        ? Haptics.ImpactFeedbackStyle.Heavy
        : Haptics.ImpactFeedbackStyle.Light,
    );

    // A hard throw splashes back: secondary droplets chasing the first ring.
    const extras = Math.round(thrown * 4);
    for (let i = 1; i <= extras; i++) {
      setTimeout(() => {
        drop(
          DROP_X + (Math.random() - 0.5) * 0.16,
          DROP_Y + (Math.random() - 0.5) * 0.1,
          amp * 0.3,
          5,
        );
        Haptics.selectionAsync();
      }, (90 + i * 110) * captureSlowmo());
    }

    if (pull >= TRIGGER_PULL) {
      startRefresh();
    }
  };

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
    <View style={styles.root}>
      <PondCanvas
        stateRef={pond}
        probes={PROBES}
        onWave={onWave}
        style={StyleSheet.absoluteFill}
      />

      <View style={styles.header} pointerEvents="none">
        <Text style={styles.title}>still.</Text>
        <View style={styles.statusPill}>
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

      <Text style={styles.footer} pointerEvents="none">
        a GPU pond · shaders written in TypeScript · typegpu
      </Text>

      {/* Invisible scroll layer that captures the pull gesture. */}
      <ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={{ height: H + 1 }}
        scrollEventThrottle={16}
        onScroll={onScroll}
        onScrollEndDrag={onRelease}
        showsVerticalScrollIndicator={false}
        alwaysBounceVertical
      />
    </View>
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
  footer: {
    position: 'absolute',
    bottom: 34,
    alignSelf: 'center',
    color: '#33425c',
    fontSize: 11,
    letterSpacing: 0.4,
  },
});
