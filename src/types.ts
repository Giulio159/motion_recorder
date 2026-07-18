export type AspectMode = 'native' | '4:3' | '16:9';

export interface ProcessingOptions {
  threshold: number;
  decay: number;
  gain: number;
}

export interface FrameProcessor {
  resize(width: number, height: number): void;
  reset(): void;
  process(input: Uint8ClampedArray, output: Uint8ClampedArray, options: ProcessingOptions): void;
}

export interface NumericCapability {
  min: number;
  max: number;
  step?: number;
}
