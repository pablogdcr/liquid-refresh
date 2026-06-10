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
import {
  MARGIN,
  RESERVOIR_CY,
  RESERVOIR_R,
  ROW_YS,
  SCREEN_H,
  TANK_CY,
  TANK_R,
  TILE_H,
  TILE_W,
  CENTER_GUTTER,
} from './liquid/layout';

const TRIGGER_PULL = 120;

const captureSlowmo = () =>
  (globalThis as unknown as { __SLOWMO?: number }).__SLOWMO ?? 1;

const ICE = '#8fd6ff';

const TILES: ReadonlyArray<readonly [glyph: string, title: string, body: string]> = [
  ['≈', 'Fluid sim', '820 particles in compute shaders'],
  ['</>', 'TGSL', 'Shaders written in TypeScript'],
  ['◈', 'WebGPU', 'Metal & Vulkan via react-native-wgpu'],
  ['◎', 'Tilt', 'Gravity from the accelerometer'],
  ['↓', 'Pump', 'Pull the screen to push water up'],
  ['✱', 'TypeGPU', 'Toolkit by Software Mansion'],
];

export function PumpDemo() {
  const liquid = useRef<LiquidState>({
    pump: 0,
    gravity: { x: 0, y: 1 },
  });
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
    liquid.current.pump = progress;

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
      // Pump stops — gravity sends everything back down the pipes.
      liquid.current.pump = 0;
    }
  };

  const startRefresh = () => {
    refreshingRef.current = true;
    liquid.current.pump = 1;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Pump until the tank is full, then shut off and let it all
    // drain back through the pipes.
    setTimeout(() => {
      liquid.current.pump = 0;
      refreshingRef.current = false;
      setLastRefresh(
        new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      );
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    }, 4200 * captureSlowmo());
  };

  useEffect(() => {
    if (__DEV__) {
      // Capture rig — lets recording scripts trigger the full pump
      // cycle without a gesture (see __SLOWMO in LiquidCanvas).
      (globalThis as Record<string, unknown>).__startRefresh = startRefresh;
    }
  });

  return (
    <View style={styles.root}>
      <LiquidCanvas stateRef={liquid} style={StyleSheet.absoluteFill} />

      {/* Tank overlay — title floats on the water. */}
      <View style={styles.tankOverlay} pointerEvents="none">
        <Text style={styles.title}>
          Liquid Refresh<Text style={styles.titleAccent}>.</Text>
        </Text>
        <View style={styles.statusPill}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>
            {lastRefresh ? `Refreshed ${lastRefresh}` : 'Pull to pump'}
          </Text>
        </View>
      </View>

      {/* Mosaic tiles — pipes run through the gutters between them. */}
      {TILES.map(([glyph, title, body], i) => {
        const row = Math.floor(i / 2);
        const col = i % 2;
        return (
          <View
            key={title}
            style={[
              styles.tile,
              {
                top: ROW_YS[row],
                left: MARGIN + col * (TILE_W + CENTER_GUTTER),
              },
            ]}
            pointerEvents="none"
          >
            <Text style={styles.tileGlyph}>{glyph}</Text>
            <Text style={styles.tileTitle}>{title}</Text>
            <Text style={styles.tileBody}>{body}</Text>
          </View>
        );
      })}

      <Text style={styles.pumpHint} pointerEvents="none">
        pull to pump ↓
      </Text>
      <Text style={styles.footer} pointerEvents="none">
        typegpu · react-native-wgpu · expo
      </Text>

      {/* Invisible scroll layer that captures the pull gesture. */}
      <ScrollView
        style={StyleSheet.absoluteFill}
        contentContainerStyle={{ height: SCREEN_H + 1 }}
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
    backgroundColor: '#05070d',
  },
  tankOverlay: {
    position: 'absolute',
    top: TANK_CY - TANK_R,
    left: MARGIN,
    right: MARGIN,
    height: TANK_R * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    color: '#f4f8ff',
    fontSize: 30,
    fontWeight: '800',
    letterSpacing: -0.6,
  },
  titleAccent: {
    color: '#5ad1ff',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(159, 216, 255, 0.28)',
    backgroundColor: 'rgba(7, 12, 22, 0.55)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    gap: 7,
    marginTop: 8,
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
  tile: {
    position: 'absolute',
    width: TILE_W,
    height: TILE_H,
    backgroundColor: 'rgba(13, 21, 36, 0.88)',
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(159, 216, 255, 0.12)',
    padding: 14,
  },
  tileGlyph: {
    color: ICE,
    fontSize: 15,
    fontWeight: '600',
  },
  tileTitle: {
    color: '#e9f1fd',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: -0.2,
    marginTop: 6,
  },
  tileBody: {
    color: '#62768f',
    fontSize: 12,
    lineHeight: 16,
    marginTop: 2,
  },
  pumpHint: {
    position: 'absolute',
    top: ROW_YS[2] + TILE_H + 34,
    alignSelf: 'center',
    color: '#3b4a61',
    fontSize: 12,
    letterSpacing: 0.4,
  },
  footer: {
    position: 'absolute',
    top: RESERVOIR_CY + RESERVOIR_R + 18,
    alignSelf: 'center',
    color: '#3b4a61',
    fontSize: 11,
    letterSpacing: 0.4,
  },
});
