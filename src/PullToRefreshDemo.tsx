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

const FEED = [
  ['🌊', 'GPU fluid simulation', '2,000 particles, spatial hashing, 4 substeps per frame'],
  ['⚡️', 'Shaders in TypeScript', "TGSL — the same language as the rest of the app"],
  ['📱', 'Runs on iOS and Android', 'WebGPU via react-native-wgpu (Metal / Vulkan)'],
  ['🌀', 'Tilt your phone', 'Gravity comes from the accelerometer'],
  ['💧', 'Pull to pour', 'The pull distance controls how much water pours in'],
  ['🕳', 'Release to refresh', 'The floor opens and the water drains out'],
  ['🧪', 'TypeGPU', 'Type-safe WebGPU toolkit by Software Mansion'],
  ['🚀', 'Over-engineered?', 'Absolutely.'],
] as const;

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
    liquid.current.floor = (HEADER_HEIGHT - 60) / HEADER_HEIGHT;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Pretend to fetch something while the water sloshes around.
    setTimeout(() => {
      liquid.current.drainOpen = true;
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setLastRefresh(new Date().toLocaleTimeString());

      setTimeout(() => {
        liquid.current.fill = 0;
        liquid.current.floor = 0;
        liquid.current.drainOpen = false;
        refreshingRef.current = false;
        setRefreshing(false);
      }, 1200);
    }, 2400);
  };

  return (
    <View style={styles.root}>
      <View style={styles.header} pointerEvents="none">
        <LiquidCanvas stateRef={liquid} style={StyleSheet.absoluteFill} />
      </View>
      <ScrollView
        style={styles.scroll}
        contentInset={{ top: refreshing ? HEADER_HEIGHT - 60 : 0 }}
        scrollEventThrottle={16}
        onScroll={onScroll}
        onScrollEndDrag={onRelease}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.content}>
          <Text style={styles.title}>Liquid Refresh</Text>
          <Text style={styles.subtitle}>
            {lastRefresh
              ? `Last refreshed at ${lastRefresh}`
              : 'Pull down to pour ↓'}
          </Text>
          {FEED.map(([emoji, title, body]) => (
            <View key={title} style={styles.card}>
              <Text style={styles.cardEmoji}>{emoji}</Text>
              <View style={styles.cardText}>
                <Text style={styles.cardTitle}>{title}</Text>
                <Text style={styles.cardBody}>{body}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0b1220',
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
    backgroundColor: '#0b1220',
    paddingTop: 76,
    paddingHorizontal: 20,
    paddingBottom: 60,
  },
  title: {
    color: '#f2f6ff',
    fontSize: 32,
    fontWeight: '800',
    letterSpacing: -0.5,
  },
  subtitle: {
    color: '#7e93b8',
    fontSize: 15,
    marginTop: 4,
    marginBottom: 20,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#121d33',
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
  },
  cardEmoji: {
    fontSize: 28,
    marginRight: 14,
  },
  cardText: {
    flex: 1,
  },
  cardTitle: {
    color: '#e8eefb',
    fontSize: 16,
    fontWeight: '600',
  },
  cardBody: {
    color: '#7e93b8',
    fontSize: 13,
    marginTop: 2,
  },
});
