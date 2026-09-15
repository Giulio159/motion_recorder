import type { EffectId } from './effect-config';

export type AspectMode = 'native' | '4:3' | '16:9';
export type ProcessingOptions = Record<string, number>;

export interface SliderDefinition {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  displayMultiplier?: number;
  decimals?: number;
  suffix?: string;
}

export interface EffectDefinition {
  id: number;
  label: string;
  sliders: readonly SliderDefinition[];
}

export interface NumericCapability {
  min: number;
  max: number;
  step?: number;
}

export type MainToWorkerMessage =
  | {
      type: 'process';
      buffer: ArrayBuffer;
      width: number;
      height: number;
      generation: number;
      effectId: EffectId;
      options: ProcessingOptions;
    }
  | { type: 'reset' };

export type WorkerToMainMessage =
  | { type: 'ready' }
  | { type: 'processed'; buffer: ArrayBuffer; width: number; height: number; generation: number }
  | { type: 'error'; message: string };
