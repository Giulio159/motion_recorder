import type { FrameProcessor } from '../types';
import { TypeScriptFrameProcessor } from './typescript-processor';
import { WasmFrameProcessor } from './wasm-processor';

export async function createFrameProcessor(): Promise<{ processor: FrameProcessor; engine: 'WASM' | 'TypeScript' }> {
  try {
    return { processor: await WasmFrameProcessor.create(), engine: 'WASM' };
  } catch {
    return { processor: new TypeScriptFrameProcessor(), engine: 'TypeScript' };
  }
}
