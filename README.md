# 💧 still. — Liquid Refresh

A pull-to-refresh that drops a rock into a pond.

The whole screen is a **GPU water surface** — a 2D wave-equation height
field integrated in a WebGPU compute shader and lit by a fragment shader
(surface normals → specular glints, refraction, drifting caustics). Every
shader is written in **TypeScript**, thanks to
[TypeGPU](https://docs.swmansion.com/TypeGPU/)'s TGSL. No particles, no
textures — just math on a 160×348 grid.

- **Pull to drop** — while you hold, the surface dimples under the
  suspended "rock". Release gently and one soft ring glides out; yank it
  and you get a hard splash with secondary droplets chasing the first ring.
- **Refresh = rain** — while "fetching", raindrops ring across the pond,
  ending with one big ring when it's done.
- **The cards float** — the UI reads wave heights back from the GPU a few
  times a second, so the cards bob and tilt as rings pass beneath them.
- **Tilt the phone** — the light source moves, sweeping the glints across
  the surface (top-down pond, so tilt steers light rather than gravity).

## How it works

| File | What it does |
| --- | --- |
| [`src/liquid/sim.ts`](src/liquid/sim.ts) | TGSL kernels: wave-equation update (laplacian + velocity damping), gaussian drop impulses, the held-rock dimple, probe sampling for UI feedback. |
| [`src/liquid/PondCanvas.tsx`](src/liquid/PondCanvas.tsx) | Ping-pong height buffers, the lit-water fragment shader (bilinear sampling, Blinn specular, refracted floor + caustics), GPU→JS probe readback. |
| [`src/PondDemo.tsx`](src/PondDemo.tsx) | The zen screen: floating cards, pull gesture → drop strength mapping (distance + release velocity), rain state machine, haptics. |

## Run it

```sh
npm install
npx expo prebuild -p ios
npx expo run:ios
```

Notes:

- Expo Go is not supported (`react-native-wgpu` is a native module).
- If you run from Xcode, disable **Metal API Validation** in the scheme's
  Diagnostics tab (see the [TypeGPU React Native guide](https://docs.swmansion.com/TypeGPU/integration/react-native/)).
- The iOS **simulator** throttles canvas presents to ~15fps regardless of
  GPU load — judge smoothness on a device. For smooth simulator captures
  there's a slow-motion rig: set `globalThis.__SLOWMO = 4` via the
  debugger, record, then speed the video 4× (`ffmpeg setpts=PTS/4`).

## Stack

[TypeGPU](https://github.com/software-mansion/TypeGPU) ·
[react-native-wgpu](https://github.com/wcandillon/react-native-webgpu) ·
Expo SDK 56 · React Native 0.85
