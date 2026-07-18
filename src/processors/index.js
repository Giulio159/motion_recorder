import { TypeScriptFrameProcessor } from './typescript-processor';
import { WasmFrameProcessor } from './wasm-processor';
export async function createFrameProcessor() {
    try {
        return { processor: await WasmFrameProcessor.create(), engine: 'WASM' };
    }
    catch {
        return { processor: new TypeScriptFrameProcessor(), engine: 'TypeScript' };
    }
}
