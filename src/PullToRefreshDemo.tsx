import { useEffect, useRef, useState } from 'react';
import {
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { DeviceMotion } from 'expo-sensors';
import { LiquidCanvas, type LiquidState } from './liquid/LiquidCanvas';

// Canvas covers the status bar area too — the water pours in from
// behind the Dynamic Island.
const HEADER_HEIGHT = 210;
const TRIGGER_PULL = 130;
// Fraction of the particle budget that "a full glass" uses — keeps the
// resting water level around half the header.
const FILL_TARGET = 0.6;

const ACCENTS = {
  cyan: '#5ad1ff',
  blue: '#5a8cff',
  violet: '#9b7bff',
  teal: '#4fe3c1',
  amber: '#ffc46b',
  rose: '#ff7ba9',
} as const;

const FEED: ReadonlyArray<
  readonly [emoji: string, title: string, body: string, accent: keyof typeof ACCENTS]
> = [
  ['🌊', 'GPU fluid simulation', '2,000 particles · spatial hashing · 120 Hz', 'cyan'],
  ['⚡️', 'Shaders in TypeScript', 'TGSL — the same language as the rest of the app', 'amber'],
  ['📱', 'Runs on iOS and Android', 'WebGPU via react-native-wgpu (Metal / Vulkan)', 'blue'],
  ['🌀', 'Tilt your phone', 'Gravity comes from the accelerometer', 'violet'],
  ['💧', 'Pull to pour', 'The pull distance controls how much water pours in', 'teal'],
  ['🕳', 'Release to refresh', 'The floor opens and the water drains out', 'rose'],
  ['🧪', 'TypeGPU', 'Type-safe WebGPU toolkit by Software Mansion', 'cyan'],
  ['🚀', 'Over-engineered?', 'Absolutely.', 'amber'],
];

export function PullToRefreshDemo() {
  const liquid = useRef<LiquidState>({
    fill: 0,
    floor: 0,
    drainOpen: false,
    gravity: { x: 0, y: 1 },
  });
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const lastTick = useRef(0);
  const [lastRefresh, setLastRefresh] = useState<string | null>(null);

  useEffect(() => {
    DeviceMotion.setUpdateInterval(50);
    const sub = DeviceMotion.addListener((m) => {
      const aig = m.accelerationIncludingGravity;
      if (!aig) {
        return;
      }
      // Device frame: x right, y toward the top of the screen.
      // Canvas frame: x right, y down. Flip signs here if a real-device
      // test shows the water flowing the wrong way.
      const gx = -aig.x / 9.81;
      const gy = aig.y / 9.81;
      if (Math.hypot(gx, gy) > 0.1) {
        liquid.current.gravity = { x: gx, y: gy };
      }
    });
    return () => sub.remove();
  }, []);

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (refreshingRef.current) {
      return;
    }
    const pull = Math.max(0, -e.nativeEvent.contentOffset.y);
    const progress = Math.min(1, pull / TRIGGER_PULL);
    liquid.current.fill = progress * FILL_TARGET;
    // The floor of the water container is the top edge of the content sheet.
    liquid.current.floor = Math.min(1, pull / HEADER_HEIGHT);

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
    if (-e.nativeEvent.contentOffset.y >= TRIGGER_PULL) {
      startRefresh();
    } else {
      liquid.current.fill = 0;
    }
  };

  const startRefresh = () => {
    refreshingRef.current = true;
    setRefreshing(true);
    liquid.current.fill = FILL_TARGET;
    liquid.current.floor = (HEADER_HEIGHT - 56) / HEADER_HEIGHT;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Pretend to fetch something while the water sloshes around.
    setTimeout(() => {
      liquid.current.drainOpen = true;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLastRefresh(
        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      );

      setTimeout(() => {
        liquid.current.fill = 0;
        liquid.current.floor = 0;
        liquid.current.drainOpen = false;
        refreshingRef.current = false;
        setRefreshing(false);
      }, 1300);
    }, 3200);
  };

  return (
    <View style={styles.root}>
      <View style={styles.header} pointerEvents="none">
        <LiquidCanvas stateRef={liquid} style={StyleSheet.absoluteFill} />
      </View>
      <ScrollView
        style={styles.scroll}
        contentInset={{ top: refreshing ? HEADER_HEIGHT - 56 : 0 }}
        scrollEventThrottle={16}
        onScroll={onScroll}
        onScrollEndDrag={onRelease}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          <View style={styles.statusRow}>
            <View style={styles.statusPill}>
              <View style={styles.statusDot} />
              <Text style={styles.statusText}>
                {lastRefresh ? `Refreshed ${lastRefresh}` : 'Pull to pour'}
              </Text>
            </View>
          </View>
          <Text style={styles.title}>
            Liquid Refresh<Text style={styles.titleAccent}>.</Text>
          </Text>
          <Text style={styles.subtitle}>
            A real fluid simulation in your pull-to-refresh — shaders written
            in TypeScript.
          </Text>
          {FEED.map(([emoji, title, body, accent]) => (
            <View key={title} style={styles.card}>
              <View
                style={[styles.cardChip, { backgroundColor: `${ACCENTS[accent]}1c` }]}
              >
                <Text style={styles.cardEmoji}>{emoji}</Text>
              </View>
              <View style={styles.cardText}>
                <Text style={styles.cardTitle}>{title}</Text>
                <Text style={styles.cardBody}>{body}</Text>
              </View>
            </View>
          ))}
          <Text style={styles.footer}>typegpu · react-native-wgpu · expo</Text>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#05070d',
  },
  header: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: HEADER_HEIGHT,
  },
  scroll: {
    flex: 1,
  },
  content: {
    minHeight: '100%',
    backgroundColor: '#05070d',
    paddingTop: 72,
    paddingHorizontal: 20,
    paddingBottom: 64,
  },
  statusRow: {
    flexDirection: 'row',
    marginBottom: 14,
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(159, 216, 255, 0.28)',
    backgroundColor: 'rgba(90, 209, 255, 0.07)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    gap: 7,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#5ad1ff',
  },
  statusText: {
    color: '#9fc6e8',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  title: {
    color: '#f4f8ff',
    fontSize: 36,
    fontWeight: '800',
    letterSpacing: -0.8,
  },
  titleAccent: {
    color: '#5ad1ff',
  },
  subtitle: {
    color: '#62768f',
    fontSize: 15,
    lineHeight: 21,
    marginTop: 8,
    marginBottom: 24,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(13, 21, 36, 0.72)',
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(159, 216, 255, 0.1)',
    padding: 16,
    marginBottom: 12,
  },
  cardChip: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  cardEmoji: {
    fontSize: 20,
  },
  cardText: {
    flex: 1,
  },
  cardTitle: {
    color: '#e9f1fd',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
  },
  cardBody: {
    color: '#62768f',
    fontSize: 13,
    lineHeight: 18,
    marginTop: 3,
  },
  footer: {
    color: '#3b4a61',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 20,
    letterSpacing: 0.4,
  },
});
