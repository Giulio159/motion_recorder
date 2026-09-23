import type { CV, Mat } from '@techstark/opencv-js';
import type { EffectId } from './effect-config';
import type { ProcessingOptions } from './types';

export type EffectFunction = (cv: CV, frame: Mat, previousFrame: Mat | null, options: ProcessingOptions) => Mat;

function dispose(...mats: Mat[]): void {
  for (const mat of mats) mat.delete();
}

let precursorAccumulator: Mat | null = null;

function releasePrecursorState(): void {
  precursorAccumulator?.delete();
  precursorAccumulator = null;
}

function getPrecursorAccumulator(cv: CV, rows: number, cols: number): Mat {
  if (!precursorAccumulator || precursorAccumulator.rows !== rows || precursorAccumulator.cols !== cols) {
    releasePrecursorState();
    precursorAccumulator = new cv.Mat(rows, cols, cv.CV_8UC1, new cv.Scalar(0));
  }
  return precursorAccumulator;
}

export const precursorEffect: EffectFunction = (cv, frame, previousFrame, options) => {
  const currentGray = new cv.Mat();
  const previousGray = new cv.Mat();
  const currentBlurred = new cv.Mat();
  const previousBlurred = new cv.Mat();
  const difference = new cv.Mat();
  const thresholded = new cv.Mat();
  const amplified = new cv.Mat();
  const faded = new cv.Mat();
  const output = new cv.Mat();

  try {
    cv.cvtColor(frame, currentGray, cv.COLOR_RGBA2GRAY);
    cv.blur(currentGray, currentBlurred, new cv.Size(3, 3), new cv.Point(-1, -1), cv.BORDER_DEFAULT);

    const accumulator = getPrecursorAccumulator(cv, currentBlurred.rows, currentBlurred.cols);

    if (previousFrame) {
      cv.cvtColor(previousFrame, previousGray, cv.COLOR_RGBA2GRAY);
      cv.blur(previousGray, previousBlurred, new cv.Size(3, 3), new cv.Point(-1, -1), cv.BORDER_DEFAULT);
      cv.absdiff(currentBlurred, previousBlurred, difference);
      cv.threshold(difference, thresholded, options.sensitivity ?? 8, 255, cv.THRESH_TOZERO);
      cv.convertScaleAbs(thresholded, amplified, 4, 0);
      cv.convertScaleAbs(accumulator, faded, options.trail ?? 0.8, 0);
      cv.max(faded, amplified, accumulator);
    }

    cv.cvtColor(accumulator, output, cv.COLOR_GRAY2RGBA);
    return output;
  } catch (error) {
    output.delete();
    throw error;
  } finally {
    dispose(currentGray, previousGray, currentBlurred, previousBlurred, difference, thresholded, amplified, faded);
  }
};

export const lsdSilverSurferEffect: EffectFunction = (cv, frame, previousFrame, options) => {
  const currentBgr = new cv.Mat();
  const previousBgr = new cv.Mat();
  const currentHsv = new cv.Mat();
  const difference = new cv.Mat();
  const channels = new cv.MatVector();

  let channel0: Mat | null = null;
  let channel1: Mat | null = null;
  let channel2: Mat | null = null;

  const channel0_16 = new cv.Mat();
  const channel1_16 = new cv.Mat();
  const channel2_16 = new cv.Mat();
  const sum16 = new cv.Mat();
  const multiplied16 = new cv.Mat();
  const byteMask = new cv.Mat();
  const wrapped16 = new cv.Mat();
  const difference8 = new cv.Mat();
  const inverted = new cv.Mat();
  const output = new cv.Mat();

  try {
    if (!previousFrame) {
      const white = new cv.Mat(frame.rows, frame.cols, cv.CV_8UC1, new cv.Scalar(255));
      try { cv.cvtColor(white, output, cv.COLOR_GRAY2RGBA); } finally { white.delete(); }
      return output;
    }

    // This intentionally matches the original Python channel comparison.
    cv.cvtColor(frame, currentBgr, cv.COLOR_RGBA2BGR);
    cv.cvtColor(previousFrame, previousBgr, cv.COLOR_RGBA2BGR);
    cv.cvtColor(currentBgr, currentHsv, cv.COLOR_BGR2HSV);
    cv.absdiff(currentHsv, previousBgr, difference);

    cv.split(difference, channels);
    channel0 = channels.get(0);
    channel1 = channels.get(1);
    channel2 = channels.get(2);
    channel0.convertTo(channel0_16, cv.CV_16U);
    channel1.convertTo(channel1_16, cv.CV_16U);
    channel2.convertTo(channel2_16, cv.CV_16U);

    cv.add(channel0_16, channel1_16, sum16);
    cv.add(sum16, channel2_16, sum16);
    sum16.convertTo(multiplied16, cv.CV_16U, options.intensity ?? 17);

    // Keeping the lowest byte reproduces NumPy's uint8 wrapping.
    byteMask.create(frame.rows, frame.cols, cv.CV_16UC1);
    byteMask.setTo(new cv.Scalar(255));
    cv.bitwise_and(multiplied16, byteMask, wrapped16);
    wrapped16.convertTo(difference8, cv.CV_8U);
    cv.bitwise_not(difference8, inverted);
    cv.cvtColor(inverted, output, cv.COLOR_GRAY2RGBA);
    return output;
  } catch (error) {
    output.delete();
    throw error;
  } finally {
    dispose(currentBgr, previousBgr, currentHsv, difference);
    channel0?.delete();
    channel1?.delete();
    channel2?.delete();
    channels.delete();
    dispose(channel0_16, channel1_16, channel2_16, sum16, multiplied16, byteMask, wrapped16, difference8, inverted);
  }
};

export const statelessTemplateEffect: EffectFunction = (_cv, frame, _previousFrame, _options) => frame.clone();

// Slider positions 0–3 correspond to the original Python modes 3, 5, 6, 8.
const BIT_MODES = [3, 5, 6, 8] as const;
const BLEED_LENGTH = 15; // Pixels in the reduced-resolution image.

const REVERSED_BITS = Uint8Array.from({ length: 256 }, (_, value) => {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit++) reversed = (reversed << 1) | ((value >> bit) & 1);
  return reversed;
});

function corruptRgbBytes(source: Uint8Array, target: Uint8Array, mode: number): void {
  switch (mode) {
    case 1:
      for (let i = 0; i < source.length; i += 3) {
        const r = source[i]!;
        const g = source[i + 1]!;
        const b = source[i + 2]!;
        target[i] = (r & 0xf0) | (g & 0x0f);
        target[i + 1] = (g & 0xf0) | (b & 0x0f);
        target[i + 2] = (b & 0xf0) | (r & 0x0f);
      }
      break;
    case 3:
      for (let i = 0; i < source.length; i++) {
        const byte = source[i]!;
        target[i] = ((byte & 0x0f) << 4) | (byte >> 4);
      }
      break;
    case 5:
      for (let i = 0; i < source.length; i++) target[i] = REVERSED_BITS[source[i]!]!;
      break;
    case 6:
      // NumPy's roll wraps the last byte around to the first byte.
      for (let i = 0; i < source.length; i++) {
        target[i] = source[i]! ^ source[(i + source.length - 1) % source.length]!;
      }
      break;
    case 8:
      // Equivalent to unpackbits -> shift right by three -> packbits (MSB first).
      for (let i = 0; i < source.length; i++) {
        target[i] = (source[i]! >> 3) | (i ? (source[i - 1]! & 0x07) << 5 : 0);
      }
      break;
  }
}

function bleedAndUpscale(cv: CV, bgr: Mat, frame: Mat, decay: number): Mat {
  const smeared = new cv.Mat();
  const kernel = new cv.Mat(1, BLEED_LENGTH + 1, cv.CV_32FC1);
  const rgba = new cv.Mat();
  const output = new cv.Mat();

  try {
    // A causal, normalized exponential kernel: pixel x receives values
    // from x, x-1, ..., x-15. A decay of 0 leaves the image untouched.
    let total = 0;
    for (let distance = 0; distance <= BLEED_LENGTH; distance++) {
      const weight = decay ** distance;
      kernel.data32F[BLEED_LENGTH - distance] = weight;
      total += weight;
    }
    for (let i = 0; i <= BLEED_LENGTH; i++) kernel.data32F[i] = kernel.data32F[i]! / total;
    cv.filter2D(bgr, smeared, -1, kernel, new cv.Point(BLEED_LENGTH, 0), 0, cv.BORDER_REPLICATE);

    // Blend the original and the smear at a fixed strength of 0.6.
    cv.addWeighted(bgr, 0.4, smeared, 0.6, 0, bgr);
    cv.cvtColor(bgr, rgba, cv.COLOR_BGR2RGBA);
    cv.resize(rgba, output, new cv.Size(frame.cols, frame.rows), 0, 0, cv.INTER_NEAREST);
    return output;
  } catch (error) {
    output.delete();
    throw error;
  } finally {
    dispose(smeared, kernel, rgba);
  }
}

export const sminchiaBitEffect: EffectFunction = (cv, frame, _previousFrame, options) => {
  const pixelation = Math.max(1, Math.min(32, Math.round(options.pixelation ?? 4)));
  const selected = Math.max(0, Math.min(3, Math.round(options.bitMode ?? 0)));
  const decay = Math.max(0, Math.min(0.99, options.bleedDecay ?? 0.9));
  const width = Math.max(1, Math.floor(frame.cols / pixelation));
  const height = Math.max(1, Math.floor(frame.rows / pixelation));

  const small = new cv.Mat();
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  const bgr = new cv.Mat();

  try {
    cv.resize(frame, small, new cv.Size(width, height), 0, 0, cv.INTER_AREA);
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
    const corrupted = new Uint8Array(rgb.data.length);
    corruptRgbBytes(rgb.data, corrupted, BIT_MODES[selected]!);

    hsv.create(height, width, cv.CV_8UC3);
    hsv.data.set(corrupted);
    for (let i = 0; i < corrupted.length; i += 3) {
      hsv.data[i] = (corrupted[i]! * 180) >> 8; // Hue: 0–255 -> 0–179.
    }
    cv.cvtColor(hsv, bgr, cv.COLOR_HSV2BGR);
    return bleedAndUpscale(cv, bgr, frame, decay);
  } finally {
    dispose(small, rgb, hsv, bgr);
  }
};

export const sminchiaBitColoriEffect: EffectFunction = (cv, frame, _previousFrame, options) => {
  const pixelation = Math.max(1, Math.min(32, Math.round(options.pixelation ?? 4)));
  const colorMode = Math.max(2, Math.min(8, Math.round(options.colorMode ?? 2)));
  const decay = Math.max(0, Math.min(0.99, options.bleedDecay ?? 0.9));
  const width = Math.max(1, Math.floor(frame.cols / pixelation));
  const height = Math.max(1, Math.floor(frame.rows / pixelation));

  const small = new cv.Mat();
  const rgb = new cv.Mat();
  const mixed = new cv.Mat();
  const converted = new cv.Mat();
  const bgr = new cv.Mat();

  try {
    cv.resize(frame, small, new cv.Size(width, height), 0, 0, cv.INTER_AREA);
    cv.cvtColor(small, rgb, cv.COLOR_RGBA2RGB);
    mixed.create(height, width, cv.CV_8UC3);
    corruptRgbBytes(rgb.data, mixed.data, 1); // Same cross-mix as the color lab.

    if (colorMode === 2 || colorMode === 4 || colorMode === 5) {
      // Treat existing mixed bytes as H,S,V (or H,L,S) rather than converting RGB.
      converted.create(height, width, cv.CV_8UC3);
      for (let i = 0; i < mixed.data.length; i += 3) {
        const h = colorMode === 4 ? mixed.data[i + 2]! : mixed.data[i]!;
        converted.data[i] = (h * 180) >> 8;
        converted.data[i + 1] = colorMode === 4 ? mixed.data[i]! : mixed.data[i + 1]!;
        converted.data[i + 2] = colorMode === 4 ? mixed.data[i + 1]! : mixed.data[i + 2]!;
      }
      cv.cvtColor(converted, bgr, colorMode === 5 ? cv.COLOR_HLS2BGR : cv.COLOR_HSV2BGR);
    } else if (colorMode === 3) {
      // Convert mixed RGB to HSV, then display the H,S,V bytes as RGB.
      cv.cvtColor(mixed, converted, cv.COLOR_RGB2HSV);
      cv.cvtColor(converted, bgr, cv.COLOR_RGB2BGR);
    } else if (colorMode === 6) {
      cv.cvtColor(mixed, bgr, cv.COLOR_Lab2BGR);
    } else if (colorMode === 7) {
      cv.cvtColor(mixed, bgr, cv.COLOR_YCrCb2BGR);
    } else {
      // Rotate R,G,B -> G,B,R, and then display the result as RGB.
      converted.create(height, width, cv.CV_8UC3);
      for (let i = 0; i < mixed.data.length; i += 3) {
        converted.data[i] = mixed.data[i + 1]!;
        converted.data[i + 1] = mixed.data[i + 2]!;
        converted.data[i + 2] = mixed.data[i]!;
      }
      cv.cvtColor(converted, bgr, cv.COLOR_RGB2BGR);
    }

    return bleedAndUpscale(cv, bgr, frame, decay);
  } finally {
    dispose(small, rgb, mixed, converted, bgr);
  }
};

type RegisteredEffect = { process: EffectFunction; reset?: () => void };

const EFFECTS: readonly RegisteredEffect[] = [
  { process: precursorEffect, reset: releasePrecursorState },
  { process: lsdSilverSurferEffect },
  { process: sminchiaBitEffect },
  { process: sminchiaBitColoriEffect }
];

export function processEffect(cv: CV, effectId: EffectId, frame: Mat, previousFrame: Mat | null, options: ProcessingOptions): Mat {
  return EFFECTS[effectId]?.process(cv, frame, previousFrame, options) ?? frame.clone();
}

export function resetEffects(): void {
  for (const effect of EFFECTS) effect.reset?.();
}
