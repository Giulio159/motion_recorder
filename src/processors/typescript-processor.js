export class TypeScriptFrameProcessor {
    width = 0;
    height = 0;
    gray = new Float32Array(0);
    blurred = new Float32Array(0);
    previous = new Float32Array(0);
    accumulator = new Float32Array(0);
    initialized = false;
    resize(width, height) {
        if (width === this.width && height === this.height)
            return;
        this.width = width;
        this.height = height;
        const size = width * height;
        this.gray = new Float32Array(size);
        this.blurred = new Float32Array(size);
        this.previous = new Float32Array(size);
        this.accumulator = new Float32Array(size);
        this.initialized = false;
    }
    reset() {
        this.previous.fill(0);
        this.accumulator.fill(0);
        this.initialized = false;
    }
    process(input, output, options) {
        const { width: w, height: h } = this;
        const size = w * h;
        for (let i = 0, p = 0; i < size; i++, p += 4) {
            this.gray[i] = 0.299 * (input[p] ?? 0) + 0.587 * (input[p + 1] ?? 0) + 0.114 * (input[p + 2] ?? 0);
        }
        for (let y = 0; y < h; y++) {
            const y0 = Math.max(0, y - 1);
            const y1 = Math.min(h - 1, y + 1);
            for (let x = 0; x < w; x++) {
                const x0 = Math.max(0, x - 1);
                const x1 = Math.min(w - 1, x + 1);
                let sum = 0;
                let count = 0;
                for (let yy = y0; yy <= y1; yy++) {
                    const row = yy * w;
                    for (let xx = x0; xx <= x1; xx++) {
                        sum += this.gray[row + xx] ?? 0;
                        count++;
                    }
                }
                this.blurred[y * w + x] = sum / count;
            }
        }
        if (!this.initialized) {
            this.previous.set(this.blurred);
            this.initialized = true;
        }
        for (let i = 0, p = 0; i < size; i++, p += 4) {
            let diff = Math.abs((this.blurred[i] ?? 0) - (this.previous[i] ?? 0));
            if (diff < options.threshold)
                diff = 0;
            diff *= options.gain;
            const faded = (this.accumulator[i] ?? 0) * options.decay;
            const value = Math.min(255, Math.max(faded, diff)) | 0;
            this.accumulator[i] = value;
            output[p] = value;
            output[p + 1] = value;
            output[p + 2] = value;
            output[p + 3] = 255;
        }
        this.previous.set(this.blurred);
    }
}
