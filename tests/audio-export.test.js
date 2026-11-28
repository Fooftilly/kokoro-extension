/**
 * #197 — scoped audio export (sentence / chapter / article).
 * First slice: pure helpers + orchestrator; no MP3 byte concatenation.
 */
const {
    EXPORT_SCOPE,
    EXPORT_LIMITS,
    listAvailableScopes,
    resolveExportIndices,
    assertExportBounds,
    safeExportBasename,
    buildExportFilename,
    exportAudioFormat,
    exportPackaging,
    readWavPcm16Mono,
    mergeMonoPcm16Wavs,
    runScopedAudioExport,
} = require('../audio-export.js');

function pcmTone(samples, amplitude = 0.25) {
    const out = new Float32Array(samples);
    for (let i = 0; i < samples; i++) out[i] = Math.sin(i / 10) * amplitude;
    return out;
}

function encodeTinyWav(sampleCount, sampleRateHz = 24000) {
    const { encodePcm16Wav } = require('../pcm-wav.js');
    return encodePcm16Wav(pcmTone(sampleCount), sampleRateHz).buffer;
}

describe('audio-export scopes and bounds (#197)', () => {
    test('lists sentence + article for webpage article sources', () => {
        const scopes = listAvailableScopes({ sourceKind: 'article' });
        expect(scopes.map(s => s.id)).toEqual([
            EXPORT_SCOPE.SENTENCE,
            EXPORT_SCOPE.ARTICLE,
        ]);
        expect(scopes.every(s => s.available)).toBe(true);
    });

    test('lists sentence + chapter for reader chapter; document deferred', () => {
        const scopes = listAvailableScopes({ sourceKind: 'reader-chapter' });
        expect(scopes.map(s => s.id)).toEqual([
            EXPORT_SCOPE.SENTENCE,
            EXPORT_SCOPE.CHAPTER,
            EXPORT_SCOPE.DOCUMENT,
        ]);
        expect(scopes.find(s => s.id === EXPORT_SCOPE.CHAPTER).available).toBe(true);
        expect(scopes.find(s => s.id === EXPORT_SCOPE.DOCUMENT).available).toBe(false);
        expect(scopes.find(s => s.id === EXPORT_SCOPE.DOCUMENT).reason)
            .toMatch(/multi-chapter|later|deferred/i);
    });

    test('resolveExportIndices covers sentence, chapter, and article', () => {
        expect(resolveExportIndices({
            scope: EXPORT_SCOPE.SENTENCE, currentIndex: 2, sentenceCount: 5,
        })).toEqual([2]);
        expect(resolveExportIndices({
            scope: EXPORT_SCOPE.CHAPTER, currentIndex: 0, sentenceCount: 3,
        })).toEqual([0, 1, 2]);
        expect(resolveExportIndices({
            scope: EXPORT_SCOPE.ARTICLE, currentIndex: 1, sentenceCount: 4,
        })).toEqual([0, 1, 2, 3]);
        expect(() => resolveExportIndices({
            scope: EXPORT_SCOPE.DOCUMENT, currentIndex: 0, sentenceCount: 2,
        })).toThrow(/not available|deferred/i);
    });

    test('assertExportBounds enforces documented sentence and char limits', () => {
        const sentences = Array.from({ length: 3 }, (_, i) => ({
            text: 'x'.repeat(10),
        }));
        expect(() => assertExportBounds({
            indices: [0, 1, 2],
            sentences,
        })).not.toThrow();

        const tooMany = Array.from(
            { length: EXPORT_LIMITS.MAX_SENTENCES + 1 },
            () => ({ text: 'a' }),
        );
        expect(() => assertExportBounds({
            indices: tooMany.map((_, i) => i),
            sentences: tooMany,
        })).toThrow(/sentence/i);

        const long = [{ text: 'y'.repeat(EXPORT_LIMITS.MAX_CHARS + 1) }];
        expect(() => assertExportBounds({
            indices: [0],
            sentences: long,
        })).toThrow(/character|length|limit/i);
    });

    test('safe filenames strip unsafe characters and stay bounded', () => {
        // Same allowlist as overlay sentence save: letters, digits, space, _-
        expect(safeExportBasename('My Article: "Hello"/World?')).toBe(
            'My Article_ _Hello__World_',
        );
        expect(safeExportBasename('')).toBe('kokoro');
        expect(safeExportBasename('a'.repeat(200)).length).toBeLessThanOrEqual(90);
    });

    test('buildExportFilename encodes scope and optional part numbers', () => {
        expect(buildExportFilename({
            title: 'Demo',
            scope: EXPORT_SCOPE.SENTENCE,
            extension: 'wav',
            sentenceNumber: 3,
        })).toBe('Demo-sentence-3.wav');
        expect(buildExportFilename({
            title: 'Demo',
            scope: EXPORT_SCOPE.ARTICLE,
            extension: 'wav',
        })).toBe('Demo-article.wav');
        expect(buildExportFilename({
            title: 'Demo',
            scope: EXPORT_SCOPE.CHAPTER,
            extension: 'mp3',
            partIndex: 2,
            partCount: 5,
        })).toBe('Demo-chapter-part-02-of-05.mp3');
    });

    test('local backends export WAV; FastAPI exports MP3; packaging never merges MP3', () => {
        expect(exportAudioFormat('mediapipe')).toBe('wav');
        expect(exportAudioFormat('onnx')).toBe('wav');
        expect(exportAudioFormat('fastapi')).toBe('mp3');
        expect(exportPackaging('mediapipe', EXPORT_SCOPE.ARTICLE)).toBe('merged-wav');
        expect(exportPackaging('onnx', EXPORT_SCOPE.CHAPTER)).toBe('merged-wav');
        expect(exportPackaging('fastapi', EXPORT_SCOPE.ARTICLE)).toBe('separate-files');
        expect(exportPackaging('fastapi', EXPORT_SCOPE.SENTENCE)).toBe('single');
        expect(exportPackaging('mediapipe', EXPORT_SCOPE.SENTENCE)).toBe('single');
    });
});

describe('WAV merge helpers (#197)', () => {
    test('readWavPcm16Mono extracts PCM and rejects corrupt headers', () => {
        const buf = encodeTinyWav(48);
        const parsed = readWavPcm16Mono(buf);
        expect(parsed.sampleRateHz).toBe(24000);
        expect(parsed.channels).toBe(1);
        expect(parsed.bitsPerSample).toBe(16);
        expect(parsed.pcmInt16.length).toBe(48);

        expect(() => readWavPcm16Mono(new ArrayBuffer(8))).toThrow(/RIFF|WAVE|WAV/i);
    });

    test('mergeMonoPcm16Wavs concatenates PCM in order without MP3 concat', () => {
        const a = encodeTinyWav(24);
        const b = encodeTinyWav(16);
        const merged = mergeMonoPcm16Wavs([a, b]);
        const parsed = readWavPcm16Mono(merged.buffer);
        expect(parsed.pcmInt16.length).toBe(40);
        expect(parsed.sampleRateHz).toBe(24000);
    });

    test('merge refuses mismatched sample rates and oversize PCM', () => {
        const a = encodeTinyWav(8, 24000);
        const b = encodeTinyWav(8, 16000);
        expect(() => mergeMonoPcm16Wavs([a, b])).toThrow(/sample rate/i);

        const hugeCount = EXPORT_LIMITS.MAX_PCM_SAMPLES + 1;
        // Avoid allocating a real huge buffer: stub via two parts whose
        // declared lengths would exceed the limit when summed.
        const small = encodeTinyWav(8);
        expect(() => mergeMonoPcm16Wavs([small, small], {
            maxPcmSamples: 10,
        })).toThrow(/limit|too long|samples/i);
    });
});

describe('runScopedAudioExport orchestration (#197)', () => {
    test('merged local export downloads one ordered WAV and reports progress', async () => {
        const sentences = [
            { text: 'One.' },
            { text: 'Two.' },
            { text: 'Three.' },
        ];
        const progress = [];
        const releases = [];
        let savedBlob = null;
        let savedName = null;

        await runScopedAudioExport({
            scope: EXPORT_SCOPE.ARTICLE,
            currentIndex: 0,
            sentences,
            backend: 'mediapipe',
            title: 'Story',
            fetchAudioBytes: async (index) => {
                const bytes = encodeTinyWav(10 + index);
                const release = jest.fn();
                releases.push(release);
                return {
                    bytes,
                    contentType: 'audio/wav',
                    release,
                };
            },
            downloadFile: async ({ blob, bytes, filename, release }) => {
                savedBlob = blob;
                savedName = filename;
                const copy = bytes instanceof Uint8Array
                    ? bytes
                    : new Uint8Array(bytes);
                savedBlob._testBytes = copy;
                release();
            },
            onProgress: (p) => progress.push(p),
        });

        expect(savedName).toBe('Story-article.wav');
        expect(savedBlob.type).toBe('audio/wav');
        const parsed = readWavPcm16Mono(savedBlob._testBytes.buffer.slice(
            savedBlob._testBytes.byteOffset,
            savedBlob._testBytes.byteOffset + savedBlob._testBytes.byteLength,
        ));
        expect(parsed.pcmInt16.length).toBe(10 + 11 + 12);
        expect(progress.some(p => p.phase === 'synthesize')).toBe(true);
        expect(progress.some(p => p.phase === 'download')).toBe(true);
        expect(progress.at(-1).completed).toBe(3);
        expect(releases.every(r => r.mock.calls.length >= 1)).toBe(true);
    });

    test('merged chapter export uses chapter filename', async () => {
        const sentences = [{ text: 'A' }, { text: 'B' }];
        let savedName = null;
        await runScopedAudioExport({
            scope: EXPORT_SCOPE.CHAPTER,
            currentIndex: 0,
            sentences,
            backend: 'onnx',
            title: 'Ch',
            fetchAudioBytes: async (index) => ({
                bytes: encodeTinyWav(12 + index * 2),
                contentType: 'audio/wav',
                release: () => {},
            }),
            downloadFile: async ({ filename, release }) => {
                savedName = filename;
                release();
            },
        });
        expect(savedName).toBe('Ch-chapter.wav');
    });

    test('FastAPI multi-scope downloads separate MP3 parts (never concatenated)', async () => {
        const sentences = [{ text: 'A' }, { text: 'B' }, { text: 'C' }];
        const downloads = [];
        await runScopedAudioExport({
            scope: EXPORT_SCOPE.ARTICLE,
            currentIndex: 0,
            sentences,
            backend: 'fastapi',
            title: 'Remote',
            fetchAudioBytes: async (index) => {
                const bytes = Uint8Array.from(
                    Buffer.from('mp3-part-' + index, 'utf8'),
                ).buffer;
                return {
                    bytes,
                    contentType: 'audio/mpeg',
                    release: () => {},
                };
            },
            downloadFile: async ({ bytes, filename, release }) => {
                const view = bytes instanceof Uint8Array
                    ? bytes
                    : new Uint8Array(bytes);
                downloads.push({
                    filename,
                    text: Buffer.from(view).toString('utf8'),
                });
                release();
            },
        });
        expect(downloads.map(d => d.filename)).toEqual([
            'Remote-article-part-01-of-03.mp3',
            'Remote-article-part-02-of-03.mp3',
            'Remote-article-part-03-of-03.mp3',
        ]);
        expect(downloads.map(d => d.text)).toEqual([
            'mp3-part-0', 'mp3-part-1', 'mp3-part-2',
        ]);
    });

    test('cancel mid-export stops further downloads and releases resources', async () => {
        const sentences = [{ text: 'A' }, { text: 'B' }, { text: 'C' }];
        const controller = new AbortController();
        const releases = [];
        const downloads = [];
        let fetchCount = 0;

        const run = runScopedAudioExport({
            scope: EXPORT_SCOPE.ARTICLE,
            currentIndex: 0,
            sentences,
            backend: 'mediapipe',
            title: 'CancelMe',
            signal: controller.signal,
            fetchAudioBytes: async () => {
                fetchCount += 1;
                if (fetchCount === 2) controller.abort();
                const release = jest.fn();
                releases.push(release);
                return {
                    bytes: encodeTinyWav(8),
                    contentType: 'audio/wav',
                    release,
                };
            },
            downloadFile: async ({ release, filename }) => {
                downloads.push(filename);
                release();
            },
        });

        await expect(run).rejects.toMatchObject({ name: 'AbortError' });
        expect(downloads).toHaveLength(0);
        expect(releases.every(r => r.mock.calls.length >= 1)).toBe(true);
        expect(fetchCount).toBeLessThan(3);
    });

    test('failed chunk surfaces a clear error; caller releases before throw', async () => {
        const release = jest.fn();
        await expect(runScopedAudioExport({
            scope: EXPORT_SCOPE.SENTENCE,
            currentIndex: 0,
            sentences: [{ text: 'X' }],
            backend: 'mediapipe',
            title: 'Fail',
            fetchAudioBytes: async () => {
                // Pins created inside fetchAudioBytes must be released before
                // rethrowing — the orchestrator never received the lease.
                release();
                throw new Error('synthesis failed');
            },
            downloadFile: async () => {
                throw new Error('should not download');
            },
        })).rejects.toThrow(/synthesis failed/);
        expect(release).toHaveBeenCalled();
    });

    test('EXPORT_LIMITS are documented positive integers', () => {
        expect(EXPORT_LIMITS.MAX_SENTENCES).toBeGreaterThan(0);
        expect(EXPORT_LIMITS.MAX_CHARS).toBeGreaterThan(0);
        expect(EXPORT_LIMITS.MAX_PCM_SAMPLES).toBeGreaterThan(0);
        expect(EXPORT_LIMITS.MAX_CONCURRENCY).toBe(1);
    });
});
