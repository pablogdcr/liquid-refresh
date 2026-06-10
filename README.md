# 💧 still.

A screen of water you can touch.

The whole screen is a **GPU water surface** — a 2D wave-equation height
field integrated in a WebGPU compute shader and lit by a fragment shader
(surface normals → specular glints, refraction, drifting caustics). Every
shader is written in **TypeScript**, thanks to
[TypeGPU](https://docs.swmansion.com/TypeGPU/)'s TGSL. No particles, no
textures — just math on a 160×348 grid.

- **Your finger is the rock** — touching dents the surface, dragging
  trails a wake through the water, and releasing splashes right where
  your finger was. Release velocity sets the strength: set it down
  gently for one soft ring, flick it for a hard splash with secondary
  droplets chasing the first ring. A quick tap is a single raindrop.
- **The water reflects you** — the front camera (VisionCamera v5)
  feeds a reflection texture that the waves warp and scatter, like
  leaning over a pond. On the simulator (no camera) it falls back to a
  generated night sky with a moon.
- **A lake with a shore** — the water lives in an organic basin; waves
  are absorbed at the banks (no harsh edge reflections), the shoreline
  has wet sand and a waterline glint.
- **The cards float** — the UI reads wave heights back from the GPU a few
  times a second, so the cards bob and tilt as rings pass beneath them.
- **The water is above the UI** — the shader knows every card's rounded
  rect (measured via `onLayout`, bob offsets included) and switches from
  opaque pond to a translucent lighting overlay there, so glints and
  wave shadows play over the content while it stays readable.
- **Tilt the phone** — the light source moves, sweeping the glints across
  the surface (top-down pond, so tilt steers light rather than gravity).

## How it works

| File | What it does |
| --- | --- |
| [`src/liquid/sim.ts`](src/liquid/sim.ts) | TGSL kernels: wave-equation update (laplacian + velocity damping), gaussian drop impulses, the held-rock dimple, probe sampling for UI feedback. |
| [`src/liquid/PondCanvas.tsx`](src/liquid/PondCanvas.tsx) | Ping-pong height buffers, the lit-water fragment shader (bilinear sampling, Blinn specular, refracted floor + caustics), GPU→JS probe readback. |
| [`src/PondDemo.tsx`](src/PondDemo.tsx) | The zen screen: floating cards, the finger gesture (dimple → wake → velocity-scaled splash), haptics. |

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
