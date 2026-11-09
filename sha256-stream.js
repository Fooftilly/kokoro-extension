// Bounded-memory SHA-256 for offline cached model Blobs (FIPS 180-4).
// SubtleCrypto.digest() requires a contiguous input buffer and would add a
// second ~295-MB allocation to MediaPipe's existing cached model Blob.
const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
}

export class IncrementalSha256 {
    constructor() {
        this.h = new Uint32Array([
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ]);
        this.buffer = new Uint8Array(64);
        this.buffered = 0;
        this.totalBytes = 0;
        this.finished = false;
        this.words = new Uint32Array(64);
    }

    block(chunk, offset) {
        const w = this.words;
        for (let i = 0; i < 16; i++) {
            const p = offset + i * 4;
            w[i] = ((chunk[p] << 24) | (chunk[p + 1] << 16) |
                (chunk[p + 2] << 8) | chunk[p + 3]) >>> 0;
        }
        for (let i = 16; i < 64; i++) {
            const x = w[i - 15], y = w[i - 2];
            const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
            const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, h] = this.h;
        for (let i = 0; i < 64; i++) {
            const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const choice = (e & f) ^ (~e & g);
            const t1 = (h + s1 + choice + K[i] + w[i]) >>> 0;
            const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const majority = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (s0 + majority) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        const latest = [a, b, c, d, e, f, g, h];
        for (let i = 0; i < 8; i++) this.h[i] = (this.h[i] + latest[i]) >>> 0;
    }

    update(chunk) {
        if (this.finished || !(chunk instanceof Uint8Array) ||
            !Number.isSafeInteger(this.totalBytes + chunk.byteLength)) {
            throw new TypeError('Invalid SHA-256 update');
        }
        this.totalBytes += chunk.byteLength;
        let offset = 0;
        if (this.buffered) {
            const n = Math.min(64 - this.buffered, chunk.byteLength);
            this.buffer.set(chunk.subarray(0, n), this.buffered);
            this.buffered += n;
            offset = n;
            if (this.buffered === 64) {
                this.block(this.buffer, 0);
                this.buffered = 0;
            }
        }
        while (offset + 64 <= chunk.byteLength) {
            this.block(chunk, offset);
            offset += 64;
        }
        if (offset < chunk.byteLength) {
            this.buffer.set(chunk.subarray(offset), 0);
            this.buffered = chunk.byteLength - offset;
        }
        return this;
    }

    digest() {
        if (this.finished) throw new Error('SHA-256 digest already finalized');
        this.finished = true;
        this.buffer[this.buffered++] = 0x80;
        if (this.buffered > 56) {
            this.buffer.fill(0, this.buffered);
            this.block(this.buffer, 0);
            this.buffered = 0;
        }
        this.buffer.fill(0, this.buffered, 56);
        const bitLength = BigInt(this.totalBytes) * 8n;
        for (let i = 0; i < 8; i++) {
            this.buffer[63 - i] = Number((bitLength >> BigInt(i * 8)) & 255n);
        }
        this.block(this.buffer, 0);
        const output = new Uint8Array(32);
        for (let i = 0; i < 8; i++) {
            const n = this.h[i], p = i * 4;
            output[p] = n >>> 24;
            output[p + 1] = (n >>> 16) & 255;
            output[p + 2] = (n >>> 8) & 255;
            output[p + 3] = n & 255;
        }
        return output;
    }
}

// Streams the existing Blob in chunks, without constructing another full-size
// ArrayBuffer. No network requests, Cache Storage mutation, or worker setup.
export async function blobMatchesSha256(blob, asset, signal) {
    if (signal?.aborted) throw new globalThis.DOMException('Verification cancelled', 'AbortError');
    if (!blob || typeof blob.stream !== 'function' || blob.size !== asset.bytes) return false;
    if (!/^sha256-[A-Za-z0-9+/]{43}=$/.test(asset.integrity)) {
        throw new TypeError('Invalid pinned SHA-256 integrity metadata');
    }
    const hash = new IncrementalSha256();
    const reader = blob.stream().getReader();
    let completed = false;
    // Abort an in-flight read, not just the next loop iteration. A browser
    // storage stream may stall between chunks; otherwise Cancel waits for
    // reader.read() to settle before releasing the model-data lock.
    const cancelPendingRead = () => {
        void reader.cancel().catch(() => {
            // Read errors are handled by the awaiting verifier below.
        });
    };
    signal?.addEventListener('abort', cancelPendingRead, { once: true });
    try {
        while (true) {
            if (signal?.aborted) throw new globalThis.DOMException('Verification cancelled', 'AbortError');
            const { done, value } = await reader.read();
            if (signal?.aborted) throw new globalThis.DOMException('Verification cancelled', 'AbortError');
            if (done) { completed = true; break; }
            if (!(value instanceof Uint8Array) ||
                hash.totalBytes + value.byteLength > asset.bytes) return false;
            hash.update(value);
        }
    } finally {
        signal?.removeEventListener('abort', cancelPendingRead);
        if (!completed) {
            try {
                await reader.cancel();
            } catch {
                // Never mask the original stream error or user cancellation.
            }
        }
        reader.releaseLock();
    }
    if (hash.totalBytes !== asset.bytes) return false;
    const actual = 'sha256-' + globalThis.btoa(String.fromCharCode(...hash.digest()));
    return actual === asset.integrity;
}
