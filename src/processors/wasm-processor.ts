import type { FrameProcessor, ProcessingOptions } from '../types';

type WasmExports = {
  memory: WebAssembly.Memory;
  alloc: (bytes: number) => number;
  release: (ptr: number) => void;
  reset_processor: () => void;
  process_frame: (
    input: number,
    output: number,
    width: number,
    height: number,
    threshold: number,
    decay: number,
    gain: number
  ) => void;
};

export class WasmFrameProcessor implements FrameProcessor {
  private constructor(private readonly wasm: WasmExports) {}

  private width = 0;
  private height = 0;
  private inputPtr = 0;
  private outputPtr = 0;
  private byteLength = 0;

  static async create(
    url = `${import.meta.env.BASE_URL}wasm/motion_processor.wasm`
  ): Promise<WasmFrameProcessor> {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`WASM non disponibile: ${response.status}`);
    }

    const result = await WebAssembly.instantiateStreaming(response, {});

    return new WasmFrameProcessor(
      result.instance.exports as unknown as WasmExports
    );
  }

  resize(width: number, height: number): void {
    const bytes = width * height * 4;

    if (bytes === this.byteLength) return;

    if (this.inputPtr) {
      this.wasm.release(this.inputPtr);
    }

    if (this.outputPtr) {
      this.wasm.release(this.outputPtr);
    }

    this.width = width;
    this.height = height;
    this.byteLength = bytes;

    this.inputPtr = this.wasm.alloc(bytes);
    this.outputPtr = this.wasm.alloc(bytes);

    this.wasm.reset_processor();
  }

  reset(): void {
    this.wasm.reset_processor();
  }

  process(
    input: Uint8ClampedArray,
    output: Uint8ClampedArray,
    options: ProcessingOptions
  ): void {
    const memory = new Uint8ClampedArray(this.wasm.memory.buffer);

    memory.set(input, this.inputPtr);

    this.wasm.process_frame(
      this.inputPtr,
      this.outputPtr,
      this.width,
      this.height,
      options.threshold,
      options.decay,
      options.gain
    );

    output.set(
      memory.subarray(
        this.outputPtr,
        this.outputPtr + this.byteLength
      )
    );
  }
}
