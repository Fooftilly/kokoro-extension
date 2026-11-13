// Pinned, independently verifiable Kokoro data manifests. All assets are DATA,
// not executable JS/WASM. Hashes and byte sizes are from the Hugging Face Hub
// blob metadata at the exact commit SHA below (2026-11-07).
const REPOSITORIES = Object.freeze({
    mediapipe: { name: 'litert-community/Kokoro-82M', revision: '33ad69fec6c4d9eb10a547aaf9a8c63e7c446a56' },
    onnx: { name: 'onnx-community/Kokoro-82M-v1.0-ONNX', revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231' },
});

function sha256SRI(hex) {
    if (!/^[a-f0-9]{64}$/.test(hex)) throw new TypeError('Invalid SHA-256 hex digest');
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let output = '';
    for (let i = 0; i < 64; i += 6) {
        const bytes = [];
        for (let j = 0; j < 6 && i + j < 64; j += 2) {
            bytes.push(Number.parseInt(hex.slice(i + j, i + j + 2), 16));
        }
        const [a, b, c] = bytes;
        output += alphabet[a >> 2];
        output += alphabet[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)];
        output += b === undefined ? '=' : alphabet[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)];
        output += c === undefined ? '=' : alphabet[c & 63];
    }
    return 'sha256-' + output;
}

function asset(provider, path, bytes, sha256) {
    const repo = REPOSITORIES[provider];
    return Object.freeze({
        path,
        bytes,
        integrity: sha256SRI(sha256),
        url: `https://huggingface.co/${repo.name}/resolve/${repo.revision}/${path}`,
    });
}

// Dictionary data comes from the official pinned upstream revision, never the
// signed extension package. The user explicitly downloads it separately.
const ENGLISH_DICTIONARY = Object.freeze({
    provider: 'dictionary', variant: 'english',
    revision: '74790861f652b15e4ac49015a90074ad62a27690',
    assets: Object.freeze([{
        path: 'cmudict.dict',
        bytes: 3618488,
        integrity: sha256SRI('81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22'),
        url: 'https://raw.githubusercontent.com/cmusphinx/cmudict/' +
            '74790861f652b15e4ac49015a90074ad62a27690/cmudict.dict',
    }]),
});

// Explain the provenance of explicitly downloaded model DATA, not the
// separately packaged JS/WASM runtimes. Link to the pinned upstream revision
// so the stated license cannot drift with a moving main branch.
export function modelDataProvenance(manifest) {
    if (manifest?.provider === 'dictionary' &&
        manifest.revision === ENGLISH_DICTIONARY.revision) {
        const base = 'https://github.com/cmusphinx/cmudict/';
        return {
            name: 'cmusphinx/cmudict', revision: manifest.revision,
            sourceUrl: base + 'tree/' + manifest.revision,
            license: 'CMUdict permissive license',
            licenseUrl: base + 'blob/' + manifest.revision + '/LICENSE',
        };
    }
    const repo = REPOSITORIES[manifest?.provider];
    if (!repo || manifest.revision !== repo.revision) {
        throw new RangeError('Unknown pinned model-data source');
    }
    const base = 'https://huggingface.co/' + repo.name + '/';
    return {
        name: repo.name, revision: repo.revision,
        sourceUrl: base + 'tree/' + repo.revision,
        license: 'Apache-2.0',
        licenseUrl: base + 'blob/' + repo.revision + '/README.md',
    };
}

export function dictionaryManifest() {
    return { ...ENGLISH_DICTIONARY,
        assets: ENGLISH_DICTIONARY.assets.map(item => ({ ...item })) };
}

const VOICE_AF = asset('onnx', 'voices/af.bin', 524288,
    'a4f11d9d055a12bfa0db2668a3e4f0ef8fd1f1ccca69494479718e44dbf9e41a');

const VARIANTS = Object.freeze({
    'mediapipe-cpu': Object.freeze({
        provider: 'mediapipe', variant: 'cpu', label: 'MediaPipe CPU (WASM)',
        assets: Object.freeze([asset('mediapipe', 'kokoro_int8_fp16.litertlm', 294783298,
            'e7b931ee5d4b7104012a838c9eee240d19ea69cb3ca269041a3274f83dbb7fa1')]),
    }),
    'mediapipe-gpu': Object.freeze({
        provider: 'mediapipe', variant: 'gpu',
        label: 'MediaPipe GPU (experimental / unverified)',
        assets: Object.freeze([asset('mediapipe', 'kokoro_int8_gpu_fp16.litertlm', 294750530,
            '1ef178b127ec48c737daf17eabb4cea5f6b3ffbc510aced270fe5c267bbeac52')]),
    }),
    'onnx-q8': Object.freeze({
        provider: 'onnx', variant: 'q8', label: 'ONNX 8-bit CPU (WASM)',
        // The original 3.5-kB vocabulary/tokenizer mapping is incorporated as
        // data into the original extension-side tokenization implementation;
        // arbitrary text still requires a verified G2P frontend.
        assets: Object.freeze([
            asset('onnx', 'onnx/model_quantized.onnx', 92361116,
                'fbae9257e1e05ffc727e951ef9b9c98418e6d79f1c9b6b13bd59f5c9028a1478'),
            VOICE_AF,
        ]),
    }),
    'onnx-q8f16': Object.freeze({
        provider: 'onnx', variant: 'q8f16', label: 'ONNX mixed precision (experimental)',
        assets: Object.freeze([
            asset('onnx', 'onnx/model_q8f16.onnx', 86033585,
                '04c658aec1b6008857c2ad10f8c589d4180d0ec427e7e6118ceb487e215c3cd0'),
            VOICE_AF,
        ]),
    }),
});

export function listModelVariants() {
    return Object.values(VARIANTS).map(entry => ({
        key: entry.provider + '-' + entry.variant,
        label: entry.label,
        provider: entry.provider,
        variant: entry.variant,
        totalBytes: entry.assets.reduce((sum, item) => sum + item.bytes, 0),
    }));
}

export function manifestForVariant(provider, variant) {
    const entry = VARIANTS[provider + '-' + variant];
    if (!entry || entry.provider !== provider) throw new RangeError('Unsupported Kokoro model variant');
    const repo = REPOSITORIES[provider];
    return { provider, variant, revision: repo.revision, assets: entry.assets.map(a => ({ ...a })) };
}
