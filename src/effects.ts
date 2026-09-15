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

type RegisteredEffect = { process: EffectFunction; reset?: () => void };

const EFFECTS: readonly RegisteredEffect[] = [
  { process: precursorEffect, reset: releasePrecursorState },
  { process: lsdSilverSurferEffect }
];

export function processEffect(cv: CV, effectId: EffectId, frame: Mat, previousFrame: Mat | null, options: ProcessingOptions): Mat {
  return EFFECTS[effectId]?.process(cv, frame, previousFrame, options) ?? frame.clone();
}

export function resetEffects(): void {
  for (const effect of EFFECTS) effect.reset?.();
}
