// Verifies real, locally packaged official SDK exports and WASM artifacts.
// This is NOT a Kokoro model-backed inference or browser compatibility claim.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const wasmMagic = [0, 97, 115, 109, 1, 0, 0, 0];

async function checkWasm(file) {
    const data = await readFile(file);
    if (data.byteLength < wasmMagic.length ||
        wasmMagic.some((value, i) => data[i] !== value)) {
        throw new Error('Missing or malformed official WASM module: ' + file);
    }
    return data.byteLength;
}

for (const browser of ['chrome', 'firefox']) {
    const base = path.join(root, 'dist', browser);
    const mediapipeBase = path.join(base, 'runtimes', 'mediapipe');
    const onnxBase = path.join(base, 'runtimes', 'onnx');

    // Import the exact bundles shipped in the generated extension, not a Jest mock
    // or a different copy resolved from node_modules.
    const mp = await import(pathToFileURL(path.join(mediapipeBase, 'audio_bundle.mjs')).href);
    const ort = await import(pathToFileURL(path.join(onnxBase, 'ort.wasm.bundle.min.mjs')).href);
    if (typeof mp.FilesetResolver?.forAudioTasks !== 'function' ||
        typeof mp.TextToSpeech?.createFromOptions !== 'function' ||
        typeof mp.TextToSpeech.prototype.synthesize !== 'function' ||
        typeof ort.InferenceSession?.create !== 'function' ||
        typeof ort.Tensor !== 'function' || !ort.env?.wasm) {
        throw new Error(browser + ': official SDK public API missing from packaged bundles');
    }

    // Resolver output must point to real files in the signed extension package.
    const webBase = 'https://extension-package.invalid/runtimes/mediapipe/wasm';
    const resolved = await mp.FilesetResolver.forAudioTasks(webBase);
    const mediaPaths = [resolved.wasmLoaderPath, resolved.wasmBinaryPath];
    if (mediaPaths.some(url => typeof url !== 'string' || !url.startsWith(webBase + '/'))) {
        throw new Error(browser + ': MediaPipe resolver generated unexpected paths');
    }
    const mediaRoot = path.join(mediapipeBase, 'wasm');
    for (const url of mediaPaths) {
        const name = new URL(url).pathname.split('/').pop();
        const file = path.join(mediaRoot, name);
        if (name.endsWith('.wasm')) {
            await checkWasm(file);
        } else if (!(await stat(file)).isFile()) {
            throw new Error(browser + ': missing MediaPipe WASM loader');
        }
    }

    // Runtime Web uses a locally packaged WASM module, not a CDN script.
    await checkWasm(path.join(onnxBase, 'ort-wasm-simd-threaded.wasm'));
    const worker = path.join(onnxBase, 'ort-wasm-simd-threaded.mjs');
    if (!(await stat(worker)).isFile()) {
        throw new Error(browser + ': missing packaged ONNX module');
    }
    console.log(browser + ': official MediaPipe and ONNX JS exports and WASM assets are packaged');
}
console.log('No models loaded or audio inferred. Chrome/Firefox extension-context acceptance still required.');
