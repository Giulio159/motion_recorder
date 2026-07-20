import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { createFrameProcessor } from './processors';
import type { AspectMode, NumericCapability } from './types';

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
const fpsSelect = document.querySelector<HTMLSelectElement>('#fpsSelect')!;
const aspectSelect = document.querySelector<HTMLSelectElement>('#aspectSelect')!;
const zoomRow = document.querySelector<HTMLElement>('#zoomRow')!;
const zoom = document.querySelector<HTMLInputElement>('#zoom')!;
const zoomValue = document.querySelector<HTMLOutputElement>('#zoomValue')!;
const sensitivity = document.querySelector<HTMLInputElement>('#sensitivity')!;
const sensitivityValue = document.querySelector<HTMLOutputElement>('#sensitivityValue')!;
const trail = document.querySelector<HTMLInputElement>('#trail')!;
const trailValue = document.querySelector<HTMLOutputElement>('#trailValue')!;
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
const GAIN = 4;
const ZOOM_APPLY_DELAY_MS = 120;

let stream: MediaStream | null = null;
let track: MediaStreamTrack | null = null;
let facingMode: 'user' | 'environment' = 'environment';
let aspectMode: AspectMode = 'native';
let requestedFps = 30;
let running = false;
let paused = false;
let callbackId = 0;
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

const { processor, engine } = await createFrameProcessor();
setStatus(`Motore ${engine}`);

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

function preferredMedium(min: number, max: number): number {
  const common = [15, 24, 25, 30, 50, 60, 120].filter((fps) => fps >= min && fps <= max);
  const target = (min + max) / 2;
  return common.reduce((best, fps) => Math.abs(fps - target) < Math.abs(best - target) ? fps : best, common[0] ?? Math.round(target));
}

function configureFps(): void {
  if (!track) return;
  const capabilities = track.getCapabilities() as MediaTrackCapabilities & { frameRate?: NumericCapability };
  const range = numericCapability(capabilities.frameRate);
  const current = track.getSettings().frameRate ?? 30;
  const min = Math.max(1, Math.ceil(range?.min ?? current));
  const max = Math.max(min, Math.floor(range?.max ?? current));
  const medium = preferredMedium(min, max);
  const presets = new Map<string, number>([
    [`Minimo · ${min}`, min],
    [`Medio · ${medium}`, medium],
    [`Massimo · ${max}`, max]
  ]);
  if (min <= 30 && max >= 30) presets.set('30 FPS', 30);
  if (min <= 60 && max >= 60) presets.set('60 FPS', 60);

  fpsSelect.replaceChildren();
  for (const [label, value] of presets) {
    fpsSelect.add(new Option(label, String(value)));
  }

  requestedFps = [...presets.values()].reduce((best, value) => Math.abs(value - current) < Math.abs(best - current) ? value : best, max);
  fpsSelect.value = String(requestedFps);
  fpsSelect.disabled = false;
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
  processor.resize(width, height);
  processor.reset();
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

function processFrame(): void {
  if (!running || paused) return;
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    drawSourceFrame();
    const input = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const output = ctx.createImageData(canvas.width, canvas.height);
    processor.process(input.data, output.data, {
      threshold: Number(sensitivity.value),
      decay: Number(trail.value) / 100,
      gain: GAIN
    });
    ctx.putImageData(output, 0, 0);
    frameCounter++;
    const now = performance.now();
    if (now - meterStartedAt >= 1000) {
      const measured = frameCounter * 1000 / (now - meterStartedAt);
      fpsMeter.textContent = `${measured.toFixed(0)} fps`;
      frameCounter = 0;
      meterStartedAt = now;
    }
  }
  scheduleFrame();
}

function scheduleFrame(): void {
  if (!running || paused) return;
  if ('requestVideoFrameCallback' in video) {
    callbackId = video.requestVideoFrameCallback(() => processFrame());
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
  try {
    await track.applyConstraints({ frameRate: { ideal: fps, max: fps } });
    const actual = track.getSettings().frameRate;
    requestedFps = actual ?? fps;
    setStatus(actual ? `Live · camera ${actual.toFixed(0)} fps` : `Live · richiesta ${fps} fps`);
  } catch (error) {
    console.warn('FPS non applicabili', error);
    configureFps();
  }
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
fpsSelect.addEventListener('change', () => { void applyFps(Number(fpsSelect.value)); });
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
sensitivity.addEventListener('input', () => { sensitivityValue.value = sensitivity.value; });
trail.addEventListener('input', () => { trailValue.value = trail.value; });

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
  if (zoomTimer !== null) window.clearTimeout(zoomTimer);
  if (lastVideoUrl) URL.revokeObjectURL(lastVideoUrl);
  if (lastPhotoUrl) URL.revokeObjectURL(lastPhotoUrl);
});
