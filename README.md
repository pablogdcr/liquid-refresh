# 💧 Liquid Refresh

The most over-engineered pull-to-refresh in React Native.

The water is a **real GPU fluid simulation** — 2,000 particles integrated in
WebGPU compute shaders, with spatial-hash neighbor search, rendered as
metaballs by a full-screen fragment shader. And every shader is written in
**TypeScript**, thanks to [TypeGPU](https://docs.swmansion.com/TypeGPU/)'s
TGSL.

- **Pull to pour** — the pull distance controls how much water rains in from
  behind the Dynamic Island.
- **The content sheet is the floor** — the water rests exactly on the top edge
  of the scroll content and gets shoved around as you drag.
- **Tilt your phone** — gravity comes from the accelerometer
  (`expo-sensors` DeviceMotion).
- **Release to refresh** — the water sloshes while "fetching", then the floor
  opens and it drains away. With haptics, obviously.

## How it works

| File | What it does |
| --- | --- |
| [`src/liquid/sim.ts`](src/liquid/sim.ts) | All GPU code: particle struct, bind group layouts, and four TGSL kernels — clear grid, bin particles (atomics), SPH-ish force integration, and metaball density sampling. |
| [`src/liquid/LiquidCanvas.tsx`](src/liquid/LiquidCanvas.tsx) | React component: buffers and pipelines via `@typegpu/react` hooks, two sim substeps + one render pass per frame. |
| [`src/PullToRefreshDemo.tsx`](src/PullToRefreshDemo.tsx) | The actual pull-to-refresh: scroll tracking, refresh state machine, device motion → gravity vector, haptics. |

The simulation runs in normalized container space. A `floorY` uniform tracks
the top edge of the scroll content, so the same sim works mid-pull, held open
during refresh, and draining. Inactive particles are parked above the canvas
in a staggered column — raising the active count makes them rain in like a
pour instead of teleporting into place.

## Run it

```sh
npm install
npx expo prebuild -p ios
npx expo run:ios
```

Notes:

- Expo Go is not supported (`react-native-wgpu` is a native module) — you need
  the prebuild + run flow above.
- If you run from Xcode, disable **Metal API Validation** in the scheme's
  Diagnostics tab (see the [TypeGPU React Native guide](https://docs.swmansion.com/TypeGPU/integration/react-native/)).
- Tilt gravity needs a physical device; the simulator falls back to straight
  down.

## Stack

[TypeGPU](https://github.com/software-mansion/TypeGPU) ·
[react-native-wgpu](https://github.com/wcandillon/react-native-webgpu) ·
Expo SDK 56 · React Native 0.85
