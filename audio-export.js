/**
 * Scoped audio export helpers (#197).
 *
 * Pure orchestration: resolve scopes, enforce documented size limits, merge
 * mono PCM WAV in order, and never concatenate compressed MP3 byte streams.
 * Overlay / reader UI wires synthesis + downloads on top of these helpers.
 */

export const EXPORT_SCOPE = Object.freeze({
    SENTENCE: 'sentence',
    CHAPTER: 'chapter',
    ARTICLE: 'article',
    DOCUMENT: 'document',
});

/** Documented hard caps — refuse rather than freeze the reader or grow without bound. */
export const EXPORT_LIMITS = Object.freeze({
    MAX_SENTENCES: 500,
    MAX_CHARS: 120_000,
    /** 30 minutes of 24 kHz mono PCM across the whole merged export. */
    MAX_PCM_SAMPLES: 24_000 * 60 * 30,
    MAX_CONCURRENCY: 1,
});

const LOCAL_BACKENDS = new Set(['mediapipe', 'onnx']);

function throwAbort() {
    throw new DOMException('Audio export cancelled', 'AbortError');
}

function ensureNotAborted(signal) {
    if (signal?.aborted) throwAbort();
}

function ensureExportSession(signal, isSessionValid) {
    ensureNotAborted(signal);
    if (typeof isSessionValid === 'function' && isSessionValid() === false) {
        throwAbort();
    }
}

function asUint8(bytes) {
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

function arrayBufferView(bytes) {
    const view = asUint8(bytes);
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

/** True when bytes begin with an ID3 tag or an MPEG frame sync word. */
export function looksLikeMp3(bytes) {
    const u8 = asUint8(bytes);
    if (u8.length < 3) return false;
    if (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) return true;
    return u8[0] === 0xFF && (u8[1] & 0xE0) === 0xE0;
}

/**
 * @param {{ sourceKind: 'article' | 'reader-chapter' | 'selection' }} opts
 * @returns {Array<{ id: string, available: boolean, reason?: string }>}
 */
export function listAvailableScopes({ sourceKind }) {
    const kind = sourceKind === 'reader-chapter' || sourceKind === 'article' ||
        sourceKind === 'selection'
        ? sourceKind
        : 'selection';

    if (kind === 'reader-chapter') {
        return [
            { id: EXPORT_SCOPE.SENTENCE, available: true },
            { id: EXPORT_SCOPE.CHAPTER, available: true },
            {
                id: EXPORT_SCOPE.DOCUMENT,
                available: false,
                reason: 'Entire-document (multi-chapter) export is deferred to a later slice',
            },
        ];
    }

    // Webpage article extraction and ordinary selections expose the loaded
    // sentence list as "Full article" (or full selection).
    return [
        { id: EXPORT_SCOPE.SENTENCE, available: true },
        { id: EXPORT_SCOPE.ARTICLE, available: true },
    ];
}

/**
 * @param {{ scope: string, currentIndex: number, sentenceCount: number }} opts
 * @returns {number[]}
 */
export function resolveExportIndices({ scope, currentIndex, sentenceCount }) {
    if (!Number.isInteger(sentenceCount) || sentenceCount < 1) {
        throw new RangeError('Export requires at least one sentence');
    }
    if (!Number.isInteger(currentIndex) || currentIndex < 0 ||
        currentIndex >= sentenceCount) {
        throw new RangeError('Invalid current sentence index for export');
    }

    if (scope === EXPORT_SCOPE.SENTENCE) return [currentIndex];
    if (scope === EXPORT_SCOPE.CHAPTER || scope === EXPORT_SCOPE.ARTICLE) {
        return Array.from({ length: sentenceCount }, (_, i) => i);
    }
    if (scope === EXPORT_SCOPE.DOCUMENT) {
        throw new Error(
            'Entire-document export is not available yet (multi-chapter deferred)');
    }
    throw new RangeError('Unknown export scope: ' + String(scope));
}

/**
 * @param {{ indices: number[], sentences: Array<{ text?: string }> }} opts
 */
export function assertExportBounds({ indices, sentences }) {
    if (!Array.isArray(indices) || indices.length === 0) {
        throw new RangeError('Export requires a nonempty sentence range');
    }
    if (indices.length > EXPORT_LIMITS.MAX_SENTENCES) {
        throw new RangeError(
            'Export exceeds the ' + EXPORT_LIMITS.MAX_SENTENCES +
            '-sentence limit; split the document or export a smaller scope');
    }
    let chars = 0;
    for (const index of indices) {
        const text = sentences?.[index]?.text;
        if (typeof text !== 'string') {
            throw new TypeError('Export sentence text missing at index ' + index);
        }
        chars += text.length;
        if (chars > EXPORT_LIMITS.MAX_CHARS) {
            throw new RangeError(
                'Export exceeds the ' + EXPORT_LIMITS.MAX_CHARS +
                '-character length limit; choose a smaller scope');
        }
    }
}

export function safeExportBasename(title) {
    const raw = typeof title === 'string' ? title : '';
    const cleaned = raw.replace(/[^a-zA-Z0-9 _-]/g, '_').trim().slice(0, 90);
    return cleaned || 'kokoro';
}

/**
 * @param {{
 *   title: string,
 *   scope: string,
 *   extension: string,
 *   sentenceNumber?: number,
 *   partIndex?: number,
 *   partCount?: number,
 * }} opts
 */
export function buildExportFilename({
    title,
    scope,
    extension,
    sentenceNumber,
    partIndex,
    partCount,
}) {
    const base = safeExportBasename(title);
    const ext = String(extension || '').replace(/^\./, '') || 'bin';
    if (scope === EXPORT_SCOPE.SENTENCE) {
        const n = Number.isInteger(sentenceNumber) && sentenceNumber > 0
            ? sentenceNumber
            : 1;
        return base + '-sentence-' + n + '.' + ext;
    }
    let name = base + '-' + scope;
    if (Number.isInteger(partIndex) && Number.isInteger(partCount) &&
        partCount > 1 && partIndex >= 1) {
        const width = String(partCount).length;
        const part = String(partIndex).padStart(Math.max(2, width), '0');
        const total = String(partCount).padStart(Math.max(2, width), '0');
        name += '-part-' + part + '-of-' + total;
    }
    return name + '.' + ext;
}

export function exportAudioFormat(backend) {
    if (LOCAL_BACKENDS.has(backend)) return 'wav';
    if (backend === 'fastapi') return 'mp3';
    throw new RangeError('Unknown TTS backend for export: ' + String(backend));
}

/**
 * Local multi-sentence exports merge PCM into one WAV.
 * FastAPI multi-sentence exports download separate MP3 files — never concat bytes.
 */
export function exportPackaging(backend, scope) {
    const format = exportAudioFormat(backend);
    if (scope === EXPORT_SCOPE.SENTENCE) return 'single';
    if (format === 'wav') return 'merged-wav';
    if (format === 'mp3') return 'separate-files';
    throw new RangeError('Unsupported export packaging');
}

function readFourCC(view, offset) {
    return String.fromCharCode(
        view.getUint8(offset),
        view.getUint8(offset + 1),
        view.getUint8(offset + 2),
        view.getUint8(offset + 3),
    );
}

function parseFmtChunk(view, dataStart) {
    const audioFormat = view.getUint16(dataStart, true);
    if (audioFormat !== 1) {
        throw new TypeError('Expected PCM WAV (format 1)');
    }
    return {
        channels: view.getUint16(dataStart + 2, true),
        sampleRateHz: view.getUint32(dataStart + 4, true),
        bitsPerSample: view.getUint16(dataStart + 14, true),
    };
}

function parseDataChunk(arrayBuffer, dataStart, size) {
    if (size % 2 !== 0) {
        throw new TypeError('WAV data chunk must be 16-bit aligned');
    }
    return new Int16Array(arrayBuffer, dataStart, size / 2);
}

function assertMonoPcm16({ sampleRateHz, channels, bitsPerSample, pcmInt16 }) {
    if (!Number.isInteger(sampleRateHz) || sampleRateHz < 8000 ||
        sampleRateHz > 192000) {
        throw new TypeError('WAV missing a valid sample rate');
    }
    if (channels !== 1) {
        throw new TypeError('Expected mono WAV for export merge');
    }
    if (bitsPerSample !== 16) {
        throw new TypeError('Expected 16-bit PCM WAV for export merge');
    }
    if (!pcmInt16 || pcmInt16.length === 0) {
        throw new TypeError('WAV missing PCM data');
    }
}

/**
 * Parse a PCM WAV buffer into mono int16 samples. Rejects non-PCM / non-mono.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {{ sampleRateHz: number, channels: number, bitsPerSample: number, pcmInt16: Int16Array }}
 */
export function readWavPcm16Mono(arrayBuffer) {
    if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength < 44) {
        throw new TypeError('Expected a RIFF/WAVE ArrayBuffer');
    }
    const view = new DataView(arrayBuffer);
    if (readFourCC(view, 0) !== 'RIFF' || readFourCC(view, 8) !== 'WAVE') {
        throw new TypeError('Expected RIFF/WAVE audio');
    }

    let offset = 12;
    let sampleRateHz = null;
    let channels = null;
    let bitsPerSample = null;
    let pcmInt16 = null;

    while (offset + 8 <= view.byteLength) {
        const id = readFourCC(view, offset);
        const size = view.getUint32(offset + 4, true);
        const dataStart = offset + 8;
        if (dataStart + size > view.byteLength) {
            throw new TypeError('Truncated WAV chunk');
        }
        if (id === 'fmt ') {
            ({ channels, sampleRateHz, bitsPerSample } =
                parseFmtChunk(view, dataStart));
        } else if (id === 'data') {
            pcmInt16 = parseDataChunk(arrayBuffer, dataStart, size);
        }
        offset = dataStart + size + (size % 2); // word-align
    }

    const parsed = { sampleRateHz, channels, bitsPerSample, pcmInt16 };
    assertMonoPcm16(parsed);
    return parsed;
}

function encodePcm16WavFromInt16(pcmInt16, sampleRateHz) {
    const bytes = new ArrayBuffer(44 + pcmInt16.length * 2);
    const view = new DataView(bytes);
    const text = (offset, value) => {
        for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
    };
    text(0, 'RIFF');
    view.setUint32(4, 36 + pcmInt16.length * 2, true);
    text(8, 'WAVE');
    text(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRateHz, true);
    view.setUint32(28, sampleRateHz * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    text(36, 'data');
    view.setUint32(40, pcmInt16.length * 2, true);
    new Int16Array(bytes, 44).set(pcmInt16);
    return new Uint8Array(bytes);
}

/**
 * Merge same-format mono PCM WAV buffers into one valid WAV.
 * @param {ArrayBuffer[]} wavBuffers
 * @param {{ maxPcmSamples?: number }} [opts]
 * @returns {Uint8Array}
 */
export function mergeMonoPcm16Wavs(wavBuffers, opts = {}) {
    if (!Array.isArray(wavBuffers) || wavBuffers.length === 0) {
        throw new RangeError('Expected at least one WAV buffer to merge');
    }
    const maxPcmSamples = Number.isInteger(opts.maxPcmSamples) && opts.maxPcmSamples > 0
        ? opts.maxPcmSamples
        : EXPORT_LIMITS.MAX_PCM_SAMPLES;

    const parts = wavBuffers.map(buf => readWavPcm16Mono(buf));
    const sampleRateHz = parts[0].sampleRateHz;
    let total = 0;
    for (const part of parts) {
        if (part.sampleRateHz !== sampleRateHz) {
            throw new TypeError('WAV sample rates must match to merge');
        }
        total += part.pcmInt16.length;
        if (total > maxPcmSamples) {
            throw new RangeError(
                'Merged export exceeds the ' + maxPcmSamples +
                '-sample PCM limit (too long)');
        }
    }

    const merged = new Int16Array(total);
    let offset = 0;
    for (const part of parts) {
        merged.set(part.pcmInt16, offset);
        offset += part.pcmInt16.length;
    }
    return encodePcm16WavFromInt16(merged, sampleRateHz);
}

function releaseAll(releases) {
    for (const release of releases) {
        try {
            release?.();
        } catch {
            // Best-effort reclaim; export failure path must still surface.
        }
    }
    releases.length = 0;
}

function partProgressMessage(verb, index, total) {
    if (total === 1) {
        return verb === 'Generating' ? 'Generating audio' :
            verb === 'Downloading' ? 'Downloading export' :
                'Download started';
    }
    const ordinal = index + 1;
    if (verb === 'Downloaded') {
        return 'Downloaded part ' + ordinal + '/' + total;
    }
    return verb + ' part ' + ordinal + '/' + total;
}

function assertVerifiedMp3(format, contentType, bytes) {
    if (format !== 'mp3') return;
    if (!contentType || !/mpeg|mp3|audio\/mpeg/i.test(contentType)) {
        throw new TypeError(
            'Refusing to label non-MP3 Content-Type as MP3 (got ' +
            String(contentType || 'missing') + ')');
    }
    if (!looksLikeMp3(bytes)) {
        throw new TypeError(
            'Refusing to save non-MP3 bytes as .mp3 (missing ID3/frame sync)');
    }
}

async function downloadCompressedParts({
    indices,
    scope,
    title,
    format,
    signal,
    isSessionValid,
    fetchAudioBytes,
    downloadFile,
    onProgress,
    releases,
}) {
    const total = indices.length;
    for (let i = 0; i < total; i++) {
        ensureExportSession(signal, isSessionValid);
        const index = indices[i];
        onProgress({
            phase: 'synthesize',
            completed: i,
            total,
            message: partProgressMessage('Generating', i, total),
        });
        const chunk = await fetchAudioBytes(index);
        const release = chunk.release || (() => {});
        releases.push(release);
        try {
            ensureExportSession(signal, isSessionValid);
            const bytes = asUint8(chunk.bytes);
            assertVerifiedMp3(format, chunk.contentType, bytes);
            const filename = buildExportFilename({
                title,
                scope,
                extension: format,
                partIndex: total > 1 ? i + 1 : undefined,
                partCount: total > 1 ? total : undefined,
                sentenceNumber: index + 1,
            });
            onProgress({
                phase: 'download',
                completed: i,
                total,
                message: partProgressMessage('Downloading', i, total),
            });
            const blob = new Blob([bytes], {
                type: chunk.contentType || 'audio/mpeg',
            });
            await downloadFile({ blob, bytes, filename, release });
            const at = releases.indexOf(release);
            if (at >= 0) releases.splice(at, 1);
            onProgress({
                phase: 'download',
                completed: i + 1,
                total,
                message: partProgressMessage('Downloaded', i, total),
            });
        } catch (error) {
            release();
            const at = releases.indexOf(release);
            if (at >= 0) releases.splice(at, 1);
            throw error;
        }
    }
    return total;
}

async function collectWavParts({
    indices,
    format,
    signal,
    isSessionValid,
    fetchAudioBytes,
    onProgress,
    maxPcmSamples = EXPORT_LIMITS.MAX_PCM_SAMPLES,
}) {
    if (format !== 'wav') {
        throw new TypeError('Merged export requires WAV from a local backend');
    }
    const sampleCap = Number.isInteger(maxPcmSamples) && maxPcmSamples > 0
        ? maxPcmSamples
        : EXPORT_LIMITS.MAX_PCM_SAMPLES;
    const total = indices.length;
    const wavParts = [];
    let runningSamples = 0;
    for (let i = 0; i < total; i++) {
        ensureExportSession(signal, isSessionValid);
        onProgress({
            phase: 'synthesize',
            completed: i,
            total,
            message: 'Generating ' + (i + 1) + '/' + total,
        });
        const chunk = await fetchAudioBytes(indices[i]);
        const release = chunk.release || (() => {});
        try {
            ensureExportSession(signal, isSessionValid);
            // Own a copy immediately, then drop the synthesis lease so memory
            // stays bounded to export buffers rather than live blob URLs.
            const owned = arrayBufferView(chunk.bytes);
            release();
            const parsed = readWavPcm16Mono(owned);
            runningSamples += parsed.pcmInt16.length;
            if (runningSamples > sampleCap) {
                throw new RangeError(
                    'Export exceeds the ' + sampleCap +
                    '-sample PCM limit (too long)');
            }
            wavParts.push(owned);
            onProgress({
                phase: 'synthesize',
                completed: i + 1,
                total,
                message: 'Generated ' + (i + 1) + '/' + total,
            });
        } catch (error) {
            release();
            throw error;
        }
    }
    return wavParts;
}

function buildMergedWavBytes(wavParts, packaging) {
    if (packaging === 'single' || wavParts.length === 1) {
        const outBytes = asUint8(wavParts[0]);
        readWavPcm16Mono(arrayBufferView(outBytes));
        return outBytes;
    }
    return mergeMonoPcm16Wavs(wavParts);
}

async function downloadMergedWavExport({
    indices,
    scope,
    title,
    format,
    packaging,
    signal,
    isSessionValid,
    fetchAudioBytes,
    downloadFile,
    onProgress,
    maxPcmSamples,
}) {
    const wavParts = await collectWavParts({
        indices,
        format,
        signal,
        isSessionValid,
        fetchAudioBytes,
        onProgress,
        maxPcmSamples,
    });
    ensureExportSession(signal, isSessionValid);
    const outBytes = buildMergedWavBytes(wavParts, packaging);
    ensureExportSession(signal, isSessionValid);
    const filename = buildExportFilename({
        title,
        scope,
        extension: format,
        sentenceNumber: indices[0] + 1,
    });
    onProgress({
        phase: 'download',
        completed: indices.length,
        total: indices.length,
        message: 'Downloading export',
    });
    const blob = new Blob([outBytes], { type: 'audio/wav' });
    // Source leases were released as each chunk was copied; no-op release.
    await downloadFile({
        blob,
        bytes: outBytes,
        filename,
        release: () => {},
    });
    return 1;
}

/**
 * Orchestrate a scoped export. Callers supply synthesis + download hooks so
 * Jest can mock backends; production wires AudioManager + downloads API.
 *
 * @param {object} options
 */
export async function runScopedAudioExport({
    scope,
    currentIndex,
    sentences,
    backend,
    title,
    signal = null,
    isSessionValid = () => true,
    maxPcmSamples = EXPORT_LIMITS.MAX_PCM_SAMPLES,
    fetchAudioBytes,
    downloadFile,
    onProgress = () => {},
}) {
    if (typeof fetchAudioBytes !== 'function' || typeof downloadFile !== 'function') {
        throw new TypeError('Export requires fetchAudioBytes and downloadFile');
    }

    const indices = resolveExportIndices({
        scope,
        currentIndex,
        sentenceCount: sentences.length,
    });
    assertExportBounds({ indices, sentences });

    const format = exportAudioFormat(backend);
    const packaging = exportPackaging(backend, scope);
    const releases = [];
    const useCompressedParts = packaging === 'separate-files' ||
        (packaging === 'single' && format === 'mp3');

    try {
        ensureExportSession(signal, isSessionValid);
        if (useCompressedParts) {
            // FastAPI (or any compressed stream): one verified file per chunk.
            // Never concatenate MP3 byte streams into a fake single file.
            const files = await downloadCompressedParts({
                indices,
                scope,
                title,
                format,
                signal,
                isSessionValid,
                fetchAudioBytes,
                downloadFile,
                onProgress,
                releases,
            });
            return { packaging, format, files };
        }

        const files = await downloadMergedWavExport({
            indices,
            scope,
            title,
            format,
            packaging,
            signal,
            isSessionValid,
            fetchAudioBytes,
            downloadFile,
            onProgress,
            maxPcmSamples,
        });
        return { packaging, format, files };
    } catch (error) {
        releaseAll(releases);
        if (signal?.aborted || error?.name === 'AbortError') throwAbort();
        throw error;
    }
}
