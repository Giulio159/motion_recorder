import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { EFFECT_DEFINITIONS, type EffectId } from './effect-config';
import {
  type AspectMode,
  type MainToWorkerMessage,
  type NumericCapability,
  type ProcessingOptions,
  type SliderDefinition,
  type WorkerToMainMessage
} from './types';

registerSW({ immediate: true });

const video = document.querySelector<HTMLVideoElement>('#cam')!;
const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
const sourceCanvas = document.createElement('canvas');
const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true })!;

const controls = document.querySelector<HTMLElement>('#controls')!;
const startPanel = document.querySelector<HTMLElement>('#startPanel')!;
const startBtn = document.querySelector<HTMLButtonElement>('#startBtn')!;
const status = document.querySelector<HTMLElement>('#status')!;
const statusText = document.querySelector<HTMLElement>('#statusText')!;
const fpsMeter = document.querySelector<HTMLElement>('#fpsMeter')!;
const fps = document.querySelector<HTMLInputElement>('#fps')!;
const fpsValue = document.querySelector<HTMLOutputElement>('#fpsValue')!;
const effectSelect = document.querySelector<HTMLSelectElement>('#effectSelect')!;
const aspectSelect = document.querySelector<HTMLSelectElement>('#aspectSelect')!;
const zoomRow = document.querySelector<HTMLElement>('#zoomRow')!;
const zoom = document.querySelector<HTMLInputElement>('#zoom')!;
const zoomValue = document.querySelector<HTMLOutputElement>('#zoomValue')!;
const effectControls = document.querySelector<HTMLElement>('#effectControls')!;
const flipBtn = document.querySelector<HTMLButtonElement>('#flipBtn')!;
const photoBtn = document.querySelector<HTMLButtonElement>('#photoBtn')!;
const recordBtn = document.querySelector<HTMLButtonElement>('#recordBtn')!;
const hudToggle = document.querySelector<HTMLButtonElement>('#hudToggle')!;
const flash = document.querySelector<HTMLElement>('#flash')!;
const saveLink = document.querySelector<HTMLAnchorElement>('#saveLink')!;
const savePhotoLink = document.querySelector<HTMLAnchorElement>('#savePhotoLink')!;
const appVersionEl = document.querySelector<HTMLElement>('#appVersion');

if (appVersionEl) {
  appVersionEl.textContent = `Motion Cam v${__APP_VERSION__}`;
}

const PROCESSING_WIDTH = 640;
const ZOOM_APPLY_DELAY_MS = 120;
const FPS_APPLY_DELAY_MS = 180;

let stream: MediaStream | null = null;
let track: MediaStreamTrack | null = null;
let facingMode: 'user' | 'environment' = 'environment';
let aspectMode: AspectMode = 'native';
let effectId: EffectId = EFFECT_DEFINITIONS[0].id;
let requestedFps = 30;
let running = false;
let paused = false;
let callbackId = 0;
let workerReady = false;
let workerBusy = false;
let surfaceGeneration = 0;
let nextFrameDueAt = 0;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let recording = false;
let lastVideoUrl: string | null = null;
let lastPhotoUrl: string | null = null;
let frameCounter = 0;
let meterStartedAt = performance.now();

let zoomTimer: number | null = null;
let pendingZoom: number | null = null;
let zoomApplying = false;
let fpsTimer: number | null = null;
let pendingFps: number | null = null;
let fpsApplying = false;

const processingWorker = new Worker(
  new URL('./effect-worker.ts', import.meta.url),
  { type: 'module' }
);

const effectValues = new Map<EffectId, ProcessingOptions>();

for (const effect of EFFECT_DEFINITIONS) {
  effectValues.set(effect.id, Object.fromEntries(effect.sliders.map((slider) => [slider.key, slider.defaultValue])));
  effectSelect.add(new Option(effect.label, String(effect.id)));
}
effectSelect.value = String(effectId);

function formatSliderValue(slider: SliderDefinition, value: number): string {
  const displayed = value * (slider.displayMultiplier ?? 1);
  const decimals = slider.decimals ?? (Number.isInteger(displayed) ? 0 : 2);
  return `${displayed.toFixed(decimals)}${slider.suffix ?? ''}`;
}

function renderEffectControls(): void {
  effectControls.replaceChildren();
  const definition = EFFECT_DEFINITIONS.find((effect) => effect.id === effectId);
  const values = effectValues.get(effectId);
  if (!definition || !values) return;

  for (const slider of definition.sliders) {
    const row = document.createElement('label');
    const label = document.createElement('span');
    const input = document.createElement('input');
    const output = document.createElement('output');

    row.className = 'slider-row';
    label.textContent = slider.label;
    input.type = 'range';
    input.min = String(slider.min);
    input.max = String(slider.max);
    input.step = String(slider.step);
    input.value = String(values[slider.key] ?? slider.defaultValue);

    const update = () => {
      const value = Number(input.value);
      values[slider.key] = value;
      output.value = formatSliderValue(slider, value);
    };

    input.addEventListener('input', update);
    update();
    row.append(label, input, output);
    effectControls.append(row);
  }
}

renderEffectControls();

function sendToWorker(message: MainToWorkerMessage, transfer: Transferable[] = []): void {
  processingWorker.postMessage(message, transfer);
}

processingWorker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
  const message = event.data;

  if (message.type === 'ready') {
    workerReady = true;
    setStatus('OpenCV pronto');
    return;
  }

  if (message.type === 'error') {
    workerBusy = false;
    console.error('Errore elaborazione:', message.message);
    setStatus(`Errore: ${message.message}`);
    return;
  }

  workerBusy = false;
  if (
    message.generation !== surfaceGeneration ||
    message.width !== canvas.width ||
    message.height !== canvas.height
  ) return;

  const frame = new ImageData(
    new Uint8ClampedArray(message.buffer),
    message.width,
    message.height
  );
  ctx.putImageData(frame, 0, 0);
  frameCounter++;

  const now = performance.now();
  if (now - meterStartedAt >= 1000) {
    const measured = frameCounter * 1000 / (now - meterStartedAt);
    fpsMeter.textContent = `${measured.toFixed(0)} fps`;
    frameCounter = 0;
    meterStartedAt = now;
  }
};

processingWorker.onerror = (event) => {
  workerReady = false;
  workerBusy = false;
  console.error('Worker non disponibile:', event.message);
  setStatus('Worker non disponibile');
};

function setStatus(text: string, isRecording = false): void {
  statusText.textContent = text;
  status.classList.toggle('recording', isRecording);
}

function numericCapability(value: unknown): NumericCapability | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<NumericCapability>;
  return typeof candidate.min === 'number' && typeof candidate.max === 'number'
    ? { min: candidate.min, max: candidate.max, step: candidate.step }
    : null;
}

function configureFps(): void {
  if (!track) return;
  const capabilities = track.getCapabilities() as MediaTrackCapabilities & { frameRate?: NumericCapability };
  const range = numericCapability(capabilities.frameRate);
  const current = track.getSettings().frameRate ?? 30;
  const min = Math.max(1, Math.ceil(range?.min ?? current));
  const max = Math.max(min, Math.floor(range?.max ?? current));
  requestedFps = Math.min(max, Math.max(min, Math.round(current)));
  fps.min = String(min);
  fps.max = String(max);
  fps.step = '1';
  fps.value = String(requestedFps);
  fpsValue.value = `${requestedFps} fps`;
  fps.disabled = false;
}

function configureZoom(): void {
  if (!track) return;
  const capabilities = track.getCapabilities() as MediaTrackCapabilities & { zoom?: NumericCapability };
  const settings = track.getSettings() as MediaTrackSettings & { zoom?: number };
  const range = numericCapability(capabilities.zoom);

  if (!range) {
    zoomRow.hidden = true;
    return;
  }

  zoom.min = String(range.min);
  zoom.max = String(range.max);
  zoom.step = String(range.step || 0.1);
  zoom.value = String(settings.zoom ?? range.min);
  zoomValue.value = `${Number(zoom.value).toFixed(1)}×`;
  zoomRow.hidden = false;
}

function outputDimensions(): { width: number; height: number } {
  const settings = track?.getSettings();
  const nativeRatio = settings?.aspectRatio || ((settings?.width && settings?.height) ? settings.width / settings.height : video.videoWidth / video.videoHeight) || 4 / 3;
  const ratio = aspectMode === '4:3' ? 4 / 3 : aspectMode === '16:9' ? 16 / 9 : nativeRatio;
  return { width: PROCESSING_WIDTH, height: Math.max(1, Math.round(PROCESSING_WIDTH / ratio)) };
}

function resizeProcessingSurface(): void {
  const { width, height } = outputDimensions();
  sourceCanvas.width = width;
  sourceCanvas.height = height;
  canvas.width = width;
  canvas.height = height;
  surfaceGeneration++;
  nextFrameDueAt = 0;
  sendToWorker({ type: 'reset' });
}

function drawSourceFrame(): void {
  const width = sourceCanvas.width;
  const height = sourceCanvas.height;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return;

  if (aspectMode === 'native') {
    sourceCtx.drawImage(video, 0, 0, vw, vh, 0, 0, width, height);
    return;
  }

  const targetRatio = width / height;
  const sourceRatio = vw / vh;
  let sx = 0, sy = 0, sw = vw, sh = vh;
  if (sourceRatio > targetRatio) {
    sw = vh * targetRatio;
    sx = (vw - sw) / 2;
  } else {
    sh = vw / targetRatio;
    sy = (vh - sh) / 2;
  }
  sourceCtx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
}

function processFrame(now = performance.now()): void {
  if (!running || paused) return;

  const frameInterval = 1000 / Math.max(1, requestedFps);
  // Camera-timed callbacks do not need a second FPS gate.
  const hasVideoFrameCallback = 'requestVideoFrameCallback' in video;
  const frameIsDue = hasVideoFrameCallback || now >= nextFrameDueAt;

  if (
    workerReady &&
    !workerBusy &&
    frameIsDue &&
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
  ) {
    drawSourceFrame();
    const input = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const buffer = input.data.buffer as ArrayBuffer;
    workerBusy = true;
    nextFrameDueAt = now + frameInterval;
    sendToWorker({
      type: 'process',
      buffer,
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      generation: surfaceGeneration,
      effectId,
      options: effectValues.get(effectId) ?? {}
    }, [buffer]);
  }
  scheduleFrame();
}

function scheduleFrame(): void {
  if (!running || paused) return;
  if ('requestVideoFrameCallback' in video) {
    callbackId = video.requestVideoFrameCallback((now) => processFrame(now));
  } else {
    callbackId = requestAnimationFrame(processFrame);
  }
}

function stopLoop(): void {
  running = false;
  if ('cancelVideoFrameCallback' in video && callbackId) video.cancelVideoFrameCallback(callbackId);
  else cancelAnimationFrame(callbackId);
}

function stopCamera(): void {
  stopLoop();
  stream?.getTracks().forEach((item) => item.stop());
  stream = null;
  track = null;
  video.srcObject = null;
}

async function startCamera(nextFacing = facingMode): Promise<void> {
  if (recording) return;
  flipBtn.disabled = true;
  setStatus('Apertura fotocamera…');
  try {
    const nextStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: nextFacing },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: requestedFps },
        resizeMode: 'none'
      } as MediaTrackConstraints
    });
    stopCamera();
    stream = nextStream;
    track = nextStream.getVideoTracks()[0] ?? null;
    if (!track) throw new Error('Nessuna traccia video disponibile');
    facingMode = nextFacing;
    video.srcObject = stream;
    await video.play();
    canvas.style.transform = facingMode === 'user' ? 'scaleX(-1)' : 'none';
    configureFps();
    configureZoom();
    resizeProcessingSurface();
    running = true;
    paused = false;
    scheduleFrame();
    startPanel.classList.add('hidden');
    setStatus('Live');
  } catch (error) {
    console.error(error);
    setStatus('Fotocamera non disponibile');
    startPanel.classList.remove('hidden');
  } finally {
    flipBtn.disabled = false;
  }
}

async function applyFps(fps: number): Promise<void> {
  if (!track) return;

  if (fpsApplying) {
    pendingFps = fps;
    return;
  }

  fpsApplying = true;
  try {
    await track.applyConstraints({ frameRate: { ideal: fps, max: fps } });
    const actual = track.getSettings().frameRate;
    requestedFps = fps;
    nextFrameDueAt = 0;
    setStatus(actual ? `Live · camera ${actual.toFixed(0)} fps` : `Live · richiesta ${fps} fps`);
  } catch (error) {
    console.warn('FPS non applicabili', error);
    configureFps();
  } finally {
    fpsApplying = false;

    if (pendingFps !== null) {
      const next = pendingFps;
      pendingFps = null;
      if (next !== requestedFps) void applyFps(next);
    }
  }
}

function scheduleFps(value: number, immediate = false): void {
  pendingFps = value;

  if (fpsTimer !== null) {
    window.clearTimeout(fpsTimer);
  }

  fpsTimer = window.setTimeout(() => {
    fpsTimer = null;
    const next = pendingFps;
    pendingFps = null;
    if (next !== null) void applyFps(next);
  }, immediate ? 0 : FPS_APPLY_DELAY_MS);
}

async function applyZoomNow(value: number): Promise<void> {
  if (!track) return;

  if (zoomApplying) {
    pendingZoom = value;
    return;
  }

  zoomApplying = true;
  try {
    await track.applyConstraints({
      advanced: [{ zoom: value } as MediaTrackConstraintSet]
    });

    const actual = (track.getSettings() as MediaTrackSettings & { zoom?: number }).zoom ?? value;
    zoom.value = String(actual);
    zoomValue.value = `${actual.toFixed(1)}×`;
  } catch (error) {
    console.warn('Zoom non applicabile', error);
  } finally {
    zoomApplying = false;

    if (pendingZoom !== null) {
      const next = pendingZoom;
      pendingZoom = null;
      if (Math.abs(next - Number(zoom.value)) > 0.001) {
        void applyZoomNow(next);
      }
    }
  }
}

function scheduleZoom(value: number, immediate = false): void {
  pendingZoom = value;

  if (zoomTimer !== null) {
    window.clearTimeout(zoomTimer);
  }

  zoomTimer = window.setTimeout(() => {
    zoomTimer = null;
    const next = pendingZoom;
    pendingZoom = null;
    if (next !== null) void applyZoomNow(next);
  }, immediate ? 0 : ZOOM_APPLY_DELAY_MS);
}

function flashFeedback(): void {
  flash.classList.remove('fire');
  void flash.offsetWidth;
  flash.classList.add('fire');
}

function replaceObjectUrl(previous: string | null, next: string): string {
  if (previous) URL.revokeObjectURL(previous);
  return next;
}

function takePhoto(): void {
  flashFeedback();
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    lastPhotoUrl = replaceObjectUrl(lastPhotoUrl, url);
    savePhotoLink.href = url;
    savePhotoLink.download = `motion-photo-${Date.now()}.png`;
    savePhotoLink.classList.add('show');
    savePhotoLink.click();
  }, 'image/png');
}

function chooseMimeType(): string {
  const candidates = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) ?? '';
}

function startRecording(): void {
  const canvasStream = canvas.captureStream(requestedFps);
  const mimeType = chooseMimeType();
  try {
    recorder = mimeType ? new MediaRecorder(canvasStream, { mimeType }) : new MediaRecorder(canvasStream);
  } catch (error) {
    console.error(error);
    setStatus('Registrazione non supportata');
    return;
  }
  chunks = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = () => {
    const type = recorder?.mimeType || 'video/webm';
    const blob = new Blob(chunks, { type });
    const url = URL.createObjectURL(blob);
    lastVideoUrl = replaceObjectUrl(lastVideoUrl, url);
    saveLink.href = url;
    saveLink.download = `motion-${Date.now()}.${type.includes('mp4') ? 'mp4' : 'webm'}`;
    saveLink.classList.add('show');
  };
  recorder.start(1000);
  recording = true;
  recordBtn.classList.add('recording');
  saveLink.classList.remove('show');
  setStatus(`Registrazione · ${Math.round(requestedFps)} fps`, true);
}

function stopRecording(): void {
  if (recorder?.state !== 'inactive') recorder?.stop();
  recording = false;
  recordBtn.classList.remove('recording');
  setStatus('Live');
}

startBtn.addEventListener('click', () => startCamera());
flipBtn.addEventListener('click', () => startCamera(facingMode === 'environment' ? 'user' : 'environment'));
photoBtn.addEventListener('click', takePhoto);
recordBtn.addEventListener('click', () => recording ? stopRecording() : startRecording());
hudToggle.addEventListener('click', () => {
  controls.classList.toggle('compact');
  hudToggle.textContent = controls.classList.contains('compact') ? '⤡' : '⤢';
});
fps.addEventListener('input', () => {
  requestedFps = Number(fps.value);
  fpsValue.value = `${requestedFps} fps`;
  scheduleFps(requestedFps);
});
fps.addEventListener('change', () => {
  scheduleFps(Number(fps.value), true);
});
effectSelect.addEventListener('change', () => {
  effectId = Number(effectSelect.value) as EffectId;
  renderEffectControls();
  surfaceGeneration++;
  sendToWorker({ type: 'reset' });
});
aspectSelect.addEventListener('change', () => {
  aspectMode = aspectSelect.value as AspectMode;
  if (track) resizeProcessingSurface();
});
zoom.addEventListener('input', () => {
  const value = Number(zoom.value);
  zoomValue.value = `${value.toFixed(1)}×`;
  scheduleZoom(value);
});
zoom.addEventListener('change', () => {
  scheduleZoom(Number(zoom.value), true);
});
document.addEventListener('visibilitychange', () => {
  paused = document.hidden;
  if (paused) {
    if (recording) stopRecording();
    setStatus('In pausa');
  } else if (running) {
    meterStartedAt = performance.now();
    frameCounter = 0;
    scheduleFrame();
    setStatus('Live');
  }
});

window.addEventListener('beforeunload', () => {
  stopCamera();
  processingWorker.terminate();
  if (zoomTimer !== null) window.clearTimeout(zoomTimer);
  if (fpsTimer !== null) window.clearTimeout(fpsTimer);
  if (lastVideoUrl) URL.revokeObjectURL(lastVideoUrl);
  if (lastPhotoUrl) URL.revokeObjectURL(lastPhotoUrl);
});
