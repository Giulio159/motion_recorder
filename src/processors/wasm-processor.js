export class WasmFrameProcessor {
    wasm;
    constructor(wasm) {
        this.wasm = wasm;
    }
    width = 0;
    height = 0;
    inputPtr = 0;
    outputPtr = 0;
    byteLength = 0;
    static async create(url = '/wasm/motion_processor.wasm') {
        const response = await fetch(url);
        if (!response.ok)
            throw new Error(`WASM non disponibile: ${response.status}`);
        const result = await WebAssembly.instantiateStreaming(response, {});
        return new WasmFrameProcessor(result.instance.exports);
    }
    resize(width, height) {
        const bytes = width * height * 4;
        if (bytes === this.byteLength)
            return;
        if (this.inputPtr)
            this.wasm.release(this.inputPtr);
        if (this.outputPtr)
            this.wasm.release(this.outputPtr);
        this.width = width;
        this.height = height;
        this.byteLength = bytes;
        this.inputPtr = this.wasm.alloc(bytes);
        this.outputPtr = this.wasm.alloc(bytes);
        this.wasm.reset_processor();
    }
    reset() { this.wasm.reset_processor(); }
    process(input, output, options) {
        const memory = new Uint8ClampedArray(this.wasm.memory.buffer);
        memory.set(input, this.inputPtr);
        this.wasm.process_frame(this.inputPtr, this.outputPtr, this.width, this.height, options.threshold, options.decay, options.gain);
        output.set(memory.subarray(this.outputPtr, this.outputPtr + this.byteLength));
    }
}
