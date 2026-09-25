import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { EFFECT_DEFINITIONS, type EffectId } from './effect-config';
import type {
  AspectMode,
  MainToWorkerMessage,
  NumericCapability,
  OutputMessage,
  ProcessingOptions,
  SliderDefinition,
  WorkerToMainMessage
} from './types';

registerSW({ immediate: true });

const params = new URLSearchParams(window.location.search);
const OUTPUT_MODE = params.get('output') === '1';
const MESSAGE_ORIGIN = window.location.origin === 'null' ? '*' : window.location.origin;

interface DisplayTarget {
  key: string;
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DetailedScreen extends Screen {
  left: number;
  top: number;
  availLeft: number;
  availTop: number;
  availWidth: number;
  availHeight: number;
  label?: string;
  isPrimary?: boolean;
}

interface ScreenDetailsLike extends EventTarget {
  screens: DetailedScreen[];
  currentScreen: DetailedScreen;
}

type WindowWithScreenDetails = Window & {
  getScreenDetails?: () => Promise<ScreenDetailsLike>;
};

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Elemento non trovato: ${selector}`);
  return element;
}

function setVersion(): void {
  const version = document.querySelector<HTMLElement>('#appVersion');
  if (version) version.textContent = `v${__APP_VERSION__}`;
}

function initOutputWindow(): void {
  document.body.classList.add('output-mode');
  setVersion();

  const canvas = required<HTMLCanvasElement>('#outputView');
  const ctx = canvas.getContext('2d', { alpha: false })!;

  const resizeCanvas = (width: number, height: number) => {
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
  };

  const clear = () => {
    ctx.save();
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width || 1, canvas.height || 1);
    ctx.restore();
  };

  window.addEventListener('message', (event: MessageEvent<OutputMessage>) => {
    if (MESSAGE_ORIGIN !== '*' && event.origin !== MESSAGE_ORIGIN) return;
    const message = event.data;
    if (!message || typeof message !== 'object' || !('type' in message)) return;

    if (message.type === 'motion-frame') {
      resizeCanvas(message.width, message.height);
      const frame = new ImageData(
        new Uint8ClampedArray(message.buffer),
        message.width,
        message.height
      );
      ctx.putImageData(frame, 0, 0);
      return;
    }

    if (message.type === 'motion-clear') clear();
  });

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (error) {
      console.warn('Fullscreen non disponibile', error);
    }
  };

  window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'f') void toggleFullscreen();
  });
  window.addEventListener('dblclick', () => void toggleFullscreen());

  const notifyReady = () => {
    window.opener?.postMessage({ type: 'motion-output-ready' }, MESSAGE_ORIGIN);
  };

  clear();
  notifyReady();
  window.setInterval(notifyReady, 1500);

  window.addEventListener('beforeunload', () => {
    window.opener?.postMessage({ type: 'motion-output-closed' }, MESSAGE_ORIGIN);
  });
}

function initController(): void {
  document.body.classList.add('controller-mode');
  setVersion();

  const video = required<HTMLVideoElement>('#cam');
  const canvas = required<HTMLCanvasElement>('#view');
  const ctx = canvas.getContext('2d', { alpha: false })!;
  const sourceCanvas = document.createElement('canvas');
  const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true, alpha: false })!;

  const cameraSelect = required<HTMLSelectElement>('#cameraSelect');
  const displaySelect = required<HTMLSelectElement>('#displaySelect');
  const effectSelect = required<HTMLSelectElement>('#effectSelect');
  const aspectSelect = required<HTMLSelectElement>('#aspectSelect');
  const resolutionSelect = required<HTMLSelectElement>('#resolutionSelect');
  const fps = required<HTMLInputElement>('#fps');
  const fpsValue = required<HTMLOutputElement>('#fpsValue');
  const transition = required<HTMLInputElement>('#transition');
  const transitionValue = required<HTMLOutputElement>('#transitionValue');
  const effectControls = required<HTMLElement>('#effectControls');
  const previewEnabled = required<HTMLInputElement>('#previewEnabled');
  const startBtn = required<HTMLButtonElement>('#startBtn');
  const refreshCamerasBtn = required<HTMLButtonElement>('#refreshCamerasBtn');
  const refreshDisplaysBtn = required<HTMLButtonElement>('#refreshDisplaysBtn');
  const openOutputBtn = required<HTMLButtonElement>('#openOutputBtn');
  const closeOutputBtn = required<HTMLButtonElement>('#closeOutputBtn');
  const statusText = required<HTMLElement>('#statusText');
  const statusDot = required<HTMLElement>('#statusDot');
  const actualFpsText = required<HTMLElement>('#actualFps');
  const processingText = required<HTMLElement>('#processingTime');
  const skippedText = required<HTMLElement>('#skippedFrames');
  const cameraFpsText = required<HTMLElement>('#cameraFps');

  let stream: MediaStream | null = null;
  let track: MediaStreamTrack | null = null;
  let running = false;
  let workerReady = false;
  let workerBusy = false;
  let callbackId = 0;
  let nextFrameDueAt = 0;
  let surfaceGeneration = 0;
  let requestedFps = 30;
  let aspectMode: AspectMode = '16:9';
  let processingWidth = 640;
  let effectId: EffectId = EFFECT_DEFINITIONS[0].id;
  let optionTimestamp = performance.now();

  let outputWindow: Window | null = null;
  let outputReady = false;
  let displays: DisplayTarget[] = [];

  let processedFrames = 0;
  let skippedFrames = 0;
  let metricsStartedAt = performance.now();
  let processingEma = 0;

  const effectTargets = new Map<EffectId, ProcessingOptions>();
  const effectCurrents = new Map<EffectId, ProcessingOptions>();

  for (const effect of EFFECT_DEFINITIONS) {
    const defaults = Object.fromEntries(
      effect.sliders.map((slider) => [slider.key, slider.defaultValue])
    );
    effectTargets.set(effect.id, { ...defaults });
    effectCurrents.set(effect.id, { ...defaults });
    effectSelect.add(new Option(effect.label, String(effect.id)));
  }
  effectSelect.value = String(effectId);

  const processingWorker = new Worker(
    new URL('./effect-worker.ts', import.meta.url),
    { type: 'module' }
  );

  function setStatus(text: string, state: 'off' | 'ready' | 'live' | 'error' = 'ready'): void {
    statusText.textContent = text;
    statusDot.dataset.state = state;
  }

  function formatSliderValue(slider: SliderDefinition, value: number): string {
    const displayed = value * (slider.displayMultiplier ?? 1);
    const decimals = slider.decimals ?? (Number.isInteger(displayed) ? 0 : 2);
    return `${displayed.toFixed(decimals)}${slider.suffix ?? ''}`;
  }

  function renderEffectControls(): void {
    effectControls.replaceChildren();
    const definition = EFFECT_DEFINITIONS.find((effect) => effect.id === effectId);
    const target = effectTargets.get(effectId);
    if (!definition || !target) return;

    for (const slider of definition.sliders) {
      const row = document.createElement('label');
      row.className = 'slider-row';

      const label = document.createElement('span');
      label.textContent = slider.label;

      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(slider.min);
      input.max = String(slider.max);
      input.step = String(slider.step);
      input.value = String(target[slider.key] ?? slider.defaultValue);

      const output = document.createElement('output');

      const update = () => {
        const value = Number(input.value);
        target[slider.key] = value;
        output.value = formatSliderValue(slider, value);
      };

      input.addEventListener('input', update);
      update();
      row.append(label, input, output);
      effectControls.append(row);
    }
  }

  renderEffectControls();

  function currentTransitionMs(): number {
    return Math.max(0, Number(transition.value));
  }

  function smoothedOptions(id: EffectId, now: number): ProcessingOptions {
    const target = effectTargets.get(id) ?? {};
    const current = effectCurrents.get(id) ?? {};
    const elapsed = Math.max(0, now - optionTimestamp);
    optionTimestamp = now;
    const duration = currentTransitionMs();
    const factor = duration <= 0
      ? 1
      : Math.min(1, 1 - Math.exp(-4.6 * elapsed / Math.max(1, duration)));
    const definition = EFFECT_DEFINITIONS.find((effect) => effect.id === id);
    const crossfadeKeys = new Set<string>(definition?.crossfadeKeys ?? []);

    for (const [key, targetValue] of Object.entries(target)) {
      if (crossfadeKeys.has(key)) {
        // Discrete visual modes must switch once. The worker crossfades the
        // rendered images; interpolating the integer selector itself would
        // step through intermediate modes and visibly jump.
        current[key] = targetValue;
        continue;
      }

      const oldValue = current[key] ?? targetValue;
      current[key] = oldValue + (targetValue - oldValue) * factor;
    }
    effectCurrents.set(id, current);
    return { ...current };
  }

  function numericCapability(value: unknown): NumericCapability | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = value as Partial<NumericCapability>;
    return typeof candidate.min === 'number' && typeof candidate.max === 'number'
      ? { min: candidate.min, max: candidate.max, step: candidate.step }
      : null;
  }

  function configureFpsControl(): void {
    if (!track) return;
    const capabilities = track.getCapabilities() as MediaTrackCapabilities & {
      frameRate?: NumericCapability;
    };
    const range = numericCapability(capabilities.frameRate);
    const current = track.getSettings().frameRate ?? requestedFps;
    const min = Math.max(1, Math.ceil(range?.min ?? Math.min(15, current)));
    const max = Math.max(min, Math.floor(range?.max ?? Math.max(60, current)));

    requestedFps = Math.min(max, Math.max(min, requestedFps));
    fps.min = String(min);
    fps.max = String(max);
    fps.step = '1';
    fps.value = String(Math.round(requestedFps));
    fpsValue.value = `${Math.round(requestedFps)} fps`;
  }

  async function refreshCameras(): Promise<void> {
    const previous = cameraSelect.value;
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cameras = devices.filter((device) => device.kind === 'videoinput');

    cameraSelect.replaceChildren();
    if (!cameras.length) {
      cameraSelect.add(new Option('Default camera', ''));
      return;
    }

    cameras.forEach((camera, index) => {
      cameraSelect.add(new Option(camera.label || `Camera ${index + 1}`, camera.deviceId));
    });

    const activeDevice = track?.getSettings().deviceId;
    const preferred = [previous, activeDevice].find(
      (id) => id && cameras.some((camera) => camera.deviceId === id)
    );
    if (preferred) cameraSelect.value = preferred;
  }

  function fallbackDisplay(): DisplayTarget {
    const screenLike = window.screen as Screen & Partial<DetailedScreen>;
    return {
      key: 'current',
      label: 'Current display',
      left: screenLike.availLeft ?? screenLike.left ?? 0,
      top: screenLike.availTop ?? screenLike.top ?? 0,
      width: screenLike.availWidth || screenLike.width,
      height: screenLike.availHeight || screenLike.height
    };
  }

  function renderDisplays(previousKey = displaySelect.value): void {
    displaySelect.replaceChildren();
    for (const display of displays) {
      displaySelect.add(new Option(display.label, display.key));
    }
    if (displays.some((display) => display.key === previousKey)) {
      displaySelect.value = previousKey;
    }
  }

  async function refreshDisplays(requestPermission = true): Promise<void> {
    const previous = displaySelect.value;
    const api = window as WindowWithScreenDetails;

    if (requestPermission && api.getScreenDetails) {
      try {
        const details = await api.getScreenDetails();
        displays = details.screens.map((screen, index) => {
          const left = screen.availLeft ?? screen.left;
          const top = screen.availTop ?? screen.top;
          const width = screen.availWidth || screen.width;
          const height = screen.availHeight || screen.height;
          const suffix = screen.isPrimary ? ' · primary' : '';
          return {
            key: `${left}:${top}:${width}:${height}`,
            label: `${screen.label || `Display ${index + 1}`}${suffix}`,
            left,
            top,
            width,
            height
          };
        });
      } catch (error) {
        console.warn('Multi-screen permission non disponibile', error);
      }
    }

    if (!displays.length) displays = [fallbackDisplay()];
    renderDisplays(previous);
  }

  function selectedDisplay(): DisplayTarget {
    return displays.find((display) => display.key === displaySelect.value)
      ?? displays[0]
      ?? fallbackDisplay();
  }

  function positionOutputWindow(): void {
    if (!outputWindow || outputWindow.closed) return;
    const display = selectedDisplay();
    try {
      outputWindow.moveTo(Math.round(display.left), Math.round(display.top));
      outputWindow.resizeTo(Math.round(display.width), Math.round(display.height));
    } catch (error) {
      console.warn('Impossibile spostare automaticamente la finestra output', error);
    }
  }

  async function openOutput(): Promise<void> {
    await refreshDisplays(true);
    const display = selectedDisplay();
    const url = new URL(window.location.href);
    url.searchParams.set('output', '1');

    const features = [
      'popup=yes',
      `left=${Math.round(display.left)}`,
      `top=${Math.round(display.top)}`,
      `width=${Math.round(display.width)}`,
      `height=${Math.round(display.height)}`
    ].join(',');

    outputWindow = window.open(url.toString(), 'motion-live-output', features);
    outputReady = false;

    if (!outputWindow) {
      setStatus('Popup output bloccato dal browser', 'error');
      return;
    }

    closeOutputBtn.disabled = false;
    window.setTimeout(positionOutputWindow, 250);
    window.setTimeout(positionOutputWindow, 900);
  }

  function closeOutput(): void {
    if (outputWindow && !outputWindow.closed) outputWindow.close();
    outputWindow = null;
    outputReady = false;
    closeOutputBtn.disabled = true;
  }

  function sendOutputClear(): void {
    if (!outputWindow || outputWindow.closed || !outputReady) return;
    outputWindow.postMessage({ type: 'motion-clear' } satisfies OutputMessage, MESSAGE_ORIGIN);
  }

  function outputDimensions(): { width: number; height: number } {
    const settings = track?.getSettings();
    const nativeRatio = settings?.aspectRatio
      || ((settings?.width && settings?.height) ? settings.width / settings.height : 0)
      || (video.videoWidth && video.videoHeight ? video.videoWidth / video.videoHeight : 16 / 9);
    const ratio = aspectMode === '4:3' ? 4 / 3 : aspectMode === '16:9' ? 16 / 9 : nativeRatio;
    return {
      width: processingWidth,
      height: Math.max(1, Math.round(processingWidth / ratio))
    };
  }

  function resizeProcessingSurface(): void {
    const { width, height } = outputDimensions();
    sourceCanvas.width = width;
    sourceCanvas.height = height;
    canvas.width = width;
    canvas.height = height;
    surfaceGeneration++;
    nextFrameDueAt = 0;
    processingWorker.postMessage({ type: 'reset' } satisfies MainToWorkerMessage);
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
    let sx = 0;
    let sy = 0;
    let sw = vw;
    let sh = vh;

    if (sourceRatio > targetRatio) {
      sw = vh * targetRatio;
      sx = (vw - sw) / 2;
    } else {
      sh = vw / targetRatio;
      sy = (vh - sh) / 2;
    }

    sourceCtx.drawImage(video, sx, sy, sw, sh, 0, 0, width, height);
  }

  function submitFrame(now: number): void {
    drawSourceFrame();
    const input = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
    const buffer = input.data.buffer as ArrayBuffer;
    workerBusy = true;

    const message: MainToWorkerMessage = {
      type: 'process',
      buffer,
      width: sourceCanvas.width,
      height: sourceCanvas.height,
      generation: surfaceGeneration,
      effectId,
      options: smoothedOptions(effectId, now),
      timestamp: now,
      transitionMs: currentTransitionMs()
    };
    processingWorker.postMessage(message, [buffer]);
  }

  function tick(now = performance.now()): void {
    if (!running) return;

    const interval = 1000 / Math.max(1, requestedFps);
    if (nextFrameDueAt <= 0) nextFrameDueAt = now;

    if (now + 0.5 >= nextFrameDueAt) {
      const slots = Math.max(1, Math.floor((now - nextFrameDueAt) / interval) + 1);
      nextFrameDueAt += slots * interval;
      skippedFrames += Math.max(0, slots - 1);

      if (
        workerReady &&
        !workerBusy &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        submitFrame(now);
      } else {
        skippedFrames++;
      }
    }

    scheduleFrame();
  }

  function scheduleFrame(): void {
    if (!running) return;
    if ('requestVideoFrameCallback' in video) {
      callbackId = video.requestVideoFrameCallback((now) => tick(now));
    } else {
      callbackId = requestAnimationFrame(tick);
    }
  }

  function stopLoop(): void {
    running = false;
    if ('cancelVideoFrameCallback' in video && callbackId) {
      video.cancelVideoFrameCallback(callbackId);
    } else if (callbackId) {
      cancelAnimationFrame(callbackId);
    }
    callbackId = 0;
  }

  function stopCamera(): void {
    stopLoop();
    stream?.getTracks().forEach((item) => item.stop());
    stream = null;
    track = null;
    video.srcObject = null;
    workerBusy = false;
    nextFrameDueAt = 0;
    processingWorker.postMessage({ type: 'reset' } satisfies MainToWorkerMessage);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    sendOutputClear();
    startBtn.textContent = 'Start camera';
    setStatus('Stopped', 'off');
  }

  async function startCamera(deviceId = cameraSelect.value): Promise<void> {
    setStatus('Opening camera…', 'ready');
    startBtn.disabled = true;

    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: requestedFps },
          resizeMode: 'none'
        } as MediaTrackConstraints
      });

      const nextTrack = nextStream.getVideoTracks()[0] ?? null;
      if (!nextTrack) throw new Error('Nessuna traccia video disponibile');

      stopLoop();
      stream?.getTracks().forEach((item) => item.stop());
      stream = nextStream;
      track = nextTrack;
      video.srcObject = stream;
      await video.play();

      configureFpsControl();
      await refreshCameras();
      resizeProcessingSurface();
      optionTimestamp = performance.now();
      metricsStartedAt = performance.now();
      processedFrames = 0;
      skippedFrames = 0;
      running = true;
      scheduleFrame();

      startBtn.textContent = 'Stop camera';
      const actual = track.getSettings().frameRate;
      cameraFpsText.textContent = actual ? `${actual.toFixed(1)} fps` : '—';
      setStatus('LIVE', 'live');
    } catch (error) {
      console.error(error);
      setStatus(error instanceof Error ? error.message : 'Camera non disponibile', 'error');
    } finally {
      startBtn.disabled = false;
    }
  }

  async function applyCameraFps(): Promise<void> {
    if (!track) return;
    try {
      await track.applyConstraints({
        frameRate: { ideal: requestedFps, max: requestedFps }
      });
      const actual = track.getSettings().frameRate;
      cameraFpsText.textContent = actual ? `${actual.toFixed(1)} fps` : '—';
    } catch (error) {
      console.warn('Il dispositivo non accetta il frame-rate richiesto', error);
      cameraFpsText.textContent = 'constraint rejected';
    }
  }

  processingWorker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
    const message = event.data;

    if (message.type === 'ready') {
      workerReady = true;
      if (!running) setStatus('Engine ready', 'ready');
      return;
    }

    if (message.type === 'error') {
      workerBusy = false;
      console.error('Errore elaborazione:', message.message);
      setStatus(`Engine error: ${message.message}`, 'error');
      return;
    }

    workerBusy = false;
    if (
      message.generation !== surfaceGeneration ||
      message.width !== canvas.width ||
      message.height !== canvas.height
    ) return;

    processedFrames++;
    processingEma = processingEma <= 0
      ? message.processingMs
      : processingEma * 0.85 + message.processingMs * 0.15;

    if (previewEnabled.checked) {
      const frame = new ImageData(
        new Uint8ClampedArray(message.buffer),
        message.width,
        message.height
      );
      ctx.putImageData(frame, 0, 0);
    }

    if (outputWindow?.closed) {
      outputWindow = null;
      outputReady = false;
      closeOutputBtn.disabled = true;
    }

    if (outputWindow && outputReady) {
      try {
        const outputMessage: OutputMessage = {
          type: 'motion-frame',
          buffer: message.buffer,
          width: message.width,
          height: message.height
        };
        outputWindow.postMessage(outputMessage, MESSAGE_ORIGIN, [message.buffer]);
      } catch (error) {
        console.warn('Output window non raggiungibile', error);
        outputReady = false;
      }
    }
  };

  processingWorker.onerror = (event) => {
    workerReady = false;
    workerBusy = false;
    console.error('Worker non disponibile:', event.message);
    setStatus('Worker non disponibile', 'error');
  };

  function updateMetrics(): void {
    const now = performance.now();
    const elapsed = now - metricsStartedAt;
    if (elapsed <= 0) return;

    const measured = processedFrames * 1000 / elapsed;
    const budget = 1000 / Math.max(1, requestedFps);
    const load = processingEma > 0 ? processingEma / budget * 100 : 0;

    actualFpsText.textContent = `${measured.toFixed(1)} fps`;
    processingText.textContent = processingEma > 0
      ? `${processingEma.toFixed(1)} ms · ${load.toFixed(0)}% budget`
      : '—';
    skippedText.textContent = String(skippedFrames);

    processedFrames = 0;
    skippedFrames = 0;
    metricsStartedAt = now;
  }

  window.setInterval(updateMetrics, 1000);

  window.addEventListener('message', (event) => {
    if (MESSAGE_ORIGIN !== '*' && event.origin !== MESSAGE_ORIGIN) return;
    if (event.source !== outputWindow) return;
    if (event.data?.type === 'motion-output-ready') {
      outputReady = true;
      closeOutputBtn.disabled = false;
      positionOutputWindow();
    } else if (event.data?.type === 'motion-output-closed') {
      outputWindow = null;
      outputReady = false;
      closeOutputBtn.disabled = true;
    }
  });

  startBtn.addEventListener('click', () => {
    if (running) stopCamera();
    else void startCamera();
  });

  refreshCamerasBtn.addEventListener('click', () => void refreshCameras());
  refreshDisplaysBtn.addEventListener('click', () => void refreshDisplays(true));
  openOutputBtn.addEventListener('click', () => void openOutput());
  closeOutputBtn.addEventListener('click', closeOutput);

  cameraSelect.addEventListener('change', () => {
    if (running) void startCamera(cameraSelect.value);
  });

  displaySelect.addEventListener('change', positionOutputWindow);

  effectSelect.addEventListener('change', () => {
    effectId = Number(effectSelect.value) as EffectId;
    optionTimestamp = performance.now();
    renderEffectControls();
  });

  aspectSelect.addEventListener('change', () => {
    aspectMode = aspectSelect.value as AspectMode;
    if (track) resizeProcessingSurface();
  });

  resolutionSelect.addEventListener('change', () => {
    processingWidth = Number(resolutionSelect.value);
    if (track) resizeProcessingSurface();
  });

  fps.addEventListener('input', () => {
    requestedFps = Number(fps.value);
    fpsValue.value = `${Math.round(requestedFps)} fps`;
    nextFrameDueAt = 0;
  });

  fps.addEventListener('change', () => void applyCameraFps());

  transition.addEventListener('input', () => {
    transitionValue.value = `${Number(transition.value).toFixed(0)} ms`;
  });

  previewEnabled.addEventListener('change', () => {
    if (!previewEnabled.checked) ctx.clearRect(0, 0, canvas.width, canvas.height);
  });

  navigator.mediaDevices.addEventListener?.('devicechange', () => void refreshCameras());

  void refreshCameras().catch(() => {
    cameraSelect.replaceChildren(new Option('Grant camera permission first', ''));
  });
  void refreshDisplays(false);

  transitionValue.value = `${Number(transition.value).toFixed(0)} ms`;
  fpsValue.value = `${requestedFps} fps`;
  closeOutputBtn.disabled = true;
  setStatus('Loading engine…', 'ready');

  window.addEventListener('beforeunload', () => {
    stopCamera();
    closeOutput();
    processingWorker.terminate();
  });
}

if (OUTPUT_MODE) initOutputWindow();
else initController();
