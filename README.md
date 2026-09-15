# Motion Cam PWA

An installable camera application with OpenCV.js effects running in a dedicated Web Worker. Processing stays on the device and the interface remains responsive by sending only one frame at a time to the worker.

## Structure

```text
src/main.ts          Camera, common controls, dynamic effect controls and recording
src/effect-worker.ts Background processing and previous-frame management
src/effects.ts       OpenCV effect functions and registry
src/effect-config.ts Effect names and slider descriptions
src/types.ts         Shared types and worker messages
index.html           Interface shell
src/style.css        Appearance
```

`main.ts` does not contain effect-specific slider logic. It reads `effect-config.ts` and generates the controls for the selected effect.

## Run locally

Requirements: Node.js, npm and a modern browser with camera, Web Worker and WebAssembly support. Camera access normally requires `localhost` or HTTPS.

```bash
npm install
npm run dev
```

Open the address printed by Vite. OpenCV can take a moment to initialize on the first load.

## Production build

```bash
npm run build
npm run preview
```

The production files are written to `dist/`. No C++, Emscripten or separate WASM compilation command is required.

## Included effects

### Il Precursore

Converts consecutive frames to grayscale, blurs them, calculates their absolute difference and preserves a fading movement trail.

- `Sensibilità` removes small changes and camera noise.
- `Scia` controls how long detected movement remains visible.

### LSD Silver Surfer

Reproduces the original Python black-and-white HSV/BGR comparison, including the unsigned 8-bit wrapping produced by `astype(np.uint8)`.

- `Intensità` replaces the fixed multiplication by `17`.

## Common effect interface

Every function in `src/effects.ts` has this interface:

```ts
const myEffect: EffectFunction = (cv, frame, previousFrame, options) => {
  const output = new cv.Mat();
  return output;
};
```

- `frame` is the current RGBA camera frame.
- `previousFrame` is the preceding RGBA frame or `null` on the first frame.
- `options` contains the selected effect's slider values.
- The returned matrix must be a complete RGBA frame with the original dimensions.

Delete temporary OpenCV matrices inside the effect. Do not delete the returned matrix; the worker deletes it after copying the output.

`statelessTemplateEffect()` is included as a starting point for an effect that only uses the current frame.

## Add an effect

### 1. Add the function

Write it in `src/effects.ts` using the common interface:

```ts
export const grayscaleEffect: EffectFunction = (cv, frame, _previousFrame, options) => {
  const gray = new cv.Mat();
  const output = new cv.Mat();

  try {
    const intensity = options.intensity ?? 1;
    cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);
    cv.convertScaleAbs(gray, gray, intensity, 0);
    cv.cvtColor(gray, output, cv.COLOR_GRAY2RGBA);
    return output;
  } catch (error) {
    output.delete();
    throw error;
  } finally {
    gray.delete();
  }
};
```

### 2. Register it

Add the function to `EFFECTS` in `src/effects.ts`. Its array position is its numeric id:

```ts
const EFFECTS: readonly RegisteredEffect[] = [
  { process: precursorEffect, reset: releasePrecursorState }, // id 0
  { process: lsdSilverSurferEffect },                         // id 1
  { process: grayscaleEffect }                                // id 2
];
```

Add a `reset` function only when the effect owns persistent matrices or other state.

### 3. Describe its controls

Add the matching id to `EFFECT_DEFINITIONS` in `src/effect-config.ts`:

```ts
{
  id: 2,
  label: 'Grigio',
  sliders: [
    { key: 'intensity', label: 'Intensità', min: 0.1, max: 3, step: 0.1, defaultValue: 1, suffix: '×' }
  ]
}
```

The interface creates these sliders automatically and shows them only when that effect is selected. `main.ts`, `effect-worker.ts` and `index.html` do not need effect-specific changes.

An effect without parameters uses an empty list:

```ts
{ id: 2, label: 'Grigio', sliders: [] }
```

## Edit sliders

Each slider definition supports:

```ts
{
  key: 'intensity',
  label: 'Intensità',
  min: 1,
  max: 30,
  step: 1,
  defaultValue: 17,
  displayMultiplier: 1,
  decimals: 0,
  suffix: ''
}
```

Only `key`, `label`, `min`, `max`, `step` and `defaultValue` are required. The effect reads the value with:

```ts
const intensity = options.intensity ?? 17;
```

Values are remembered separately for each effect when switching through the dropdown.

## Remove an effect

1. Remove its function and state from `src/effects.ts`.
2. Remove it from the `EFFECTS` registry.
3. Remove its entry from `EFFECT_DEFINITIONS`.
4. Renumber later ids so they still match the registry positions.

## Common controls

These remain visible independently of the selected effect:

- effect and aspect-ratio dropdowns;
- camera FPS slider bounded by reported camera capabilities;
- hardware zoom when exposed by the camera and browser;
- front/rear camera selection;
- PNG photos and MP4/WebM recording when supported.
