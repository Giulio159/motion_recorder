/// <reference lib="webworker" />

import cvModule from '@techstark/opencv-js';
import type { CV, Mat } from '@techstark/opencv-js';
import { processEffect, resetEffects } from './effects';
import { EFFECT_DEFINITIONS, type EffectId } from './effect-config';
import type { MainToWorkerMessage, ProcessingOptions, WorkerToMainMessage } from './types';

const workerScope = self as DedicatedWorkerGlobalScope;

interface LiveTransition {
  fromEffectId: EffectId;
  fromOptions: ProcessingOptions;
  toEffectId: EffectId;
  toOptions: ProcessingOptions;
  startedAt: number;
  durationMs: number;
}

let cv: CV | null = null;
let previousFrame: Mat | null = null;
let activeEffect: EffectId | null = null;
let lastOptions: ProcessingOptions | null = null;
let transition: LiveTransition | null = null;

function send(message: WorkerToMainMessage, transfer: Transferable[] = []): void {
  workerScope.postMessage(message, transfer);
}

function releasePreviousFrame(): void {
  previousFrame?.delete();
  previousFrame = null;
}

function resetProcessingState(): void {
  releasePreviousFrame();
  transition = null;
  activeEffect = null;
  lastOptions = null;
  resetEffects();
}

function crossfadeKeys(effectId: EffectId): readonly string[] {
  return EFFECT_DEFINITIONS.find((effect) => effect.id === effectId)?.crossfadeKeys ?? [];
}

function discreteModeChanged(
  effectId: EffectId,
  previous: ProcessingOptions | null,
  next: ProcessingOptions
): boolean {
  if (!previous) return false;
  return crossfadeKeys(effectId).some((key) => previous[key] !== next[key]);
}

function smootherstep(value: number): number {
  const t = Math.min(1, Math.max(0, value));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function transitionProgress(state: LiveTransition, timestamp: number): number {
  if (state.durationMs <= 0) return 1;
  return smootherstep(Math.max(0, timestamp - state.startedAt) / state.durationMs);
}

/**
 * If the performer changes again before a fade is finished, reduce the old
 * two-sided transition to whichever live side is currently visually dominant.
 * This keeps the next transition live without ever falling back to a frozen
 * screenshot. A very rapid second change can therefore make a small visual
 * shortcut, but it never freezes the video or requires three effects at once.
 */
function collapseRunningTransition(timestamp: number): {
  effectId: EffectId;
  options: ProcessingOptions;
} | null {
  if (!transition) {
    if (activeEffect === null || !lastOptions) return null;
    return { effectId: activeEffect, options: { ...lastOptions } };
  }

  const progress = transitionProgress(transition, timestamp);
  const useTarget = progress >= 0.5;
  const chosenEffect = useTarget ? transition.toEffectId : transition.fromEffectId;
  const chosenOptions = useTarget ? transition.toOptions : transition.fromOptions;

  // The only stateful effect today is Il Precursore (id 0). If it is not the
  // side we keep, release its accumulator now. If it is kept, its accumulator
  // has been updated live on every transition frame and remains valid.
  if (
    chosenEffect !== 0
    && (transition.fromEffectId === 0 || transition.toEffectId === 0)
  ) {
    resetEffects();
  }

  transition = null;
  activeEffect = chosenEffect;
  lastOptions = { ...chosenOptions };
  return { effectId: chosenEffect, options: { ...chosenOptions } };
}

function beginLiveTransition(
  timestamp: number,
  durationMs: number,
  toEffectId: EffectId,
  toOptions: ProcessingOptions
): void {
  const source = collapseRunningTransition(timestamp);

  if (!source || durationMs <= 0) {
    if (source && source.effectId !== toEffectId) {
      // Entering or leaving the stateful precursor without a fade should start
      // from a clean state and should not leave an old accumulator allocated.
      if (source.effectId === 0 || toEffectId === 0) resetEffects();
    }
    transition = null;
    activeEffect = toEffectId;
    lastOptions = { ...toOptions };
    return;
  }

  // If the new side is the stateful precursor, initialise its accumulator now.
  // When fading away from the precursor we deliberately do NOT reset here:
  // Effect A must remain alive until the crossfade actually reaches 100% B.
  if (toEffectId === 0 && source.effectId !== 0) resetEffects();

  transition = {
    fromEffectId: source.effectId,
    fromOptions: { ...source.options },
    toEffectId,
    toOptions: { ...toOptions },
    startedAt: timestamp,
    durationMs
  };

  // activeEffect always represents the selected destination. This makes the
  // normal per-frame messages for B update B rather than re-triggering a fade.
  activeEffect = toEffectId;
  lastOptions = { ...toOptions };
}

function finishLiveTransition(): void {
  if (!transition) return;

  // Once A is fully invisible, release its state if A was Il Precursore.
  if (transition.fromEffectId === 0 && transition.toEffectId !== 0) {
    resetEffects();
  }

  transition = null;
}

async function startOpenCv(): Promise<void> {
  try {
    cv = await (cvModule as unknown as Promise<CV>);
    send({ type: 'ready' });
  } catch (error) {
    send({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

void startOpenCv();

workerScope.onmessage = (event: MessageEvent<MainToWorkerMessage>) => {
  const message = event.data;

  if (message.type === 'reset') {
    resetProcessingState();
    return;
  }

  if (!cv) {
    send({ type: 'error', message: 'OpenCV non è ancora pronto' });
    return;
  }

  const startedAt = performance.now();
  let frame: Mat | null = null;
  let outputA: Mat | null = null;
  let outputB: Mat | null = null;
  let blendedOutput: Mat | null = null;

  try {
    const requestedOptions = { ...message.options };

    if (activeEffect === null || !lastOptions) {
      activeEffect = message.effectId;
      lastOptions = requestedOptions;
      // Make sure a fresh first use of the stateful effect cannot inherit state
      // left over from a worker reset/reinitialisation edge case.
      if (activeEffect === 0) resetEffects();
    } else {
      const effectChanged = message.effectId !== activeEffect;
      const modeChanged = !effectChanged
        && discreteModeChanged(message.effectId, lastOptions, requestedOptions);

      if (effectChanged || modeChanged) {
        beginLiveTransition(
          message.timestamp,
          message.transitionMs,
          message.effectId,
          requestedOptions
        );
      } else {
        lastOptions = requestedOptions;
        // Continuous sliders may still move while a transition is running.
        // Update the live B side without changing the frozen definition of A.
        if (transition && transition.toEffectId === message.effectId) {
          transition.toOptions = requestedOptions;
        }
      }
    }

    frame = cv.matFromArray(
      message.height,
      message.width,
      cv.CV_8UC4,
      new Uint8Array(message.buffer)
    );

    let rendered: Mat;

    if (transition) {
      // TRUE live crossfade: both A and B see the same current camera frame and
      // the same previous camera frame. Neither side is a cached screenshot.
      outputA = processEffect(
        cv,
        transition.fromEffectId,
        frame,
        previousFrame,
        transition.fromOptions
      );

      outputB = processEffect(
        cv,
        transition.toEffectId,
        frame,
        previousFrame,
        transition.toOptions
      );

      const progress = transitionProgress(transition, message.timestamp);
      blendedOutput = new cv.Mat();
      cv.addWeighted(outputA, 1 - progress, outputB, progress, 0, blendedOutput);
      rendered = blendedOutput;

      if (progress >= 1) finishLiveTransition();
    } else {
      outputB = processEffect(
        cv,
        message.effectId,
        frame,
        previousFrame,
        requestedOptions
      );
      rendered = outputB;
    }

    releasePreviousFrame();
    previousFrame = frame.clone();

    // OpenCV owns rendered.data in WASM memory, so copy once before transfer.
    const pixels = new Uint8ClampedArray(rendered.data);
    const buffer = pixels.buffer as ArrayBuffer;

    send({
      type: 'processed',
      buffer,
      width: message.width,
      height: message.height,
      generation: message.generation,
      processingMs: performance.now() - startedAt
    }, [buffer]);
  } catch (error) {
    send({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    frame?.delete();
    outputA?.delete();
    outputB?.delete();
    blendedOutput?.delete();
  }
};
