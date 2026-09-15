/// <reference lib="webworker" />

import cvModule from '@techstark/opencv-js';
import type { CV, Mat } from '@techstark/opencv-js';
import { processEffect, resetEffects } from './effects';
import type { EffectId } from './effect-config';
import type {
  MainToWorkerMessage,
  WorkerToMainMessage
} from './types';

const workerScope = self as DedicatedWorkerGlobalScope;

let cv: CV | null = null;
let previousFrame: Mat | null = null;
let activeEffect: EffectId | null = null;

function send(message: WorkerToMainMessage, transfer: Transferable[] = []): void {
  workerScope.postMessage(message, transfer);
}

function resetProcessingState(): void {
  previousFrame?.delete();
  previousFrame = null;
  activeEffect = null;
  resetEffects();
}

async function startOpenCv(): Promise<void> {
  try {
    // OpenCV.js initializes its WebAssembly runtime asynchronously.
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

  let frame: Mat | null = null;
  let output: Mat | null = null;

  try {
    if (message.effectId !== activeEffect) {
      resetProcessingState();
      activeEffect = message.effectId;
    }

    frame = cv.matFromArray(
      message.height,
      message.width,
      cv.CV_8UC4,
      new Uint8Array(message.buffer)
    );

    output = processEffect(
      cv,
      message.effectId,
      frame,
      previousFrame,
      message.options
    );

    previousFrame?.delete();
    previousFrame = frame.clone();

    // Copy before transferring: OpenCV owns output.data inside WASM memory.
    const pixels = new Uint8ClampedArray(output.data);
    const buffer = pixels.buffer as ArrayBuffer;

    send({
      type: 'processed',
      buffer,
      width: message.width,
      height: message.height,
      generation: message.generation
    }, [buffer]);
  } catch (error) {
    send({
      type: 'error',
      message: error instanceof Error ? error.message : String(error)
    });
  } finally {
    frame?.delete();
    output?.delete();
  }
};
