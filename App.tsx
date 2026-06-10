import { StatusBar } from 'expo-status-bar';
import { Suspense, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Canvas } from 'react-native-wgpu';
import tgpu, { d } from 'typegpu';
import { useConfigureContext, useFrame, useRoot } from '@typegpu/react';

const positions = tgpu.const(d.arrayOf(d.vec2f), [
  d.vec2f(0.0, 0.5),
  d.vec2f(-0.5, -0.5),
  d.vec2f(0.5, -0.5),
]);

function Triangle() {
  const root = useRoot();

  const pipeline = useMemo(
    () =>
      root.createRenderPipeline({
        vertex: ({ $vertexIndex: vid }) => {
          'use gpu';
          return {
            $position: d.vec4f(positions.$[vid], 0, 1),
          };
        },
        fragment: () => {
          'use gpu';
          return d.vec4f(0.114, 0.447, 0.941, 1);
        },
      }),
    [root],
  );

  const { ref, ctxRef } = useConfigureContext({ alphaMode: 'premultiplied' });

  useFrame(() => {
    const ctx = ctxRef.current;
    if (!ctx) return;

    pipeline.withColorAttachment({ view: ctx }).draw(3);
    ctx.present?.();
  });

  return <Canvas ref={ref} style={styles.canvas} transparent />;
}

export default function App() {
  return (
    <View style={styles.container}>
      <Suspense fallback={<Text style={styles.loading}>Initializing GPU…</Text>}>
        <Triangle />
      </Suspense>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b1220',
    alignItems: 'center',
    justifyContent: 'center',
  },
  canvas: {
    width: '100%',
    aspectRatio: 1,
  },
  loading: {
    color: '#8fa3c8',
  },
});
