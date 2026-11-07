const { inspectCapabilities, nearestRank, summarizeRuns } = require('../benchmark-capabilities.js');

describe('Browser backend preflight (#53)', () => {
    test('WASM and GPU adapter report is a capability check, not a benchmark', async () => {
        const requestAdapter = jest.fn(async () => ({
            features: new Set(['shader-f16']),
            limits: { maxBufferSize: 1024 },
        }));
        const report = await inspectCapabilities({
            navigator: { userAgent: 'Test Browser', gpu: { requestAdapter } },
            WebAssembly: { compile: async () => {} },
            SharedArrayBuffer: class SharedArrayBuffer {},
            crossOriginIsolated: true,
            isSecureContext: true,
        });
        expect(requestAdapter).toHaveBeenCalledTimes(1);
        expect(report).toMatchObject({
            schemaVersion: 1,
            wasmCompilation: true,
            wasmThreadsPrerequisites: true,
            webgpu: { status: 'adapter-available', features: ['shader-f16'] },
            inferenceValidated: false,
            offlineModelValidated: false,
        });
    });

    test('Firefox or GPU-disabled browser remains inspectable without WebGPU', async () => {
        const report = await inspectCapabilities({
            navigator: { userAgent: 'Firefox' },
            WebAssembly: { compile: async () => {} },
            crossOriginIsolated: false,
        });
        expect(report.webgpu.status).toBe('not-exposed');
        expect(report.wasmThreadsPrerequisites).toBe(false);
        expect(report.wasmCompilation).toBe(true);
    });

    test('no adapter and adapter rejection are distinctly reported', async () => {
        const missing = await inspectCapabilities({
            navigator: { gpu: { requestAdapter: async () => null } },
        });
        const failed = await inspectCapabilities({
            navigator: { gpu: { requestAdapter: async () => { throw Error('blocked'); } } },
        });
        expect(missing.webgpu.status).toBe('no-adapter');
        expect(failed.webgpu).toMatchObject({ status: 'request-failed', error: 'blocked' });
    });

    test('nearest-rank summary requires real typed measurements and three runs', () => {
        expect(nearestRank([12, 7, 14, 5], 50)).toBe(7);
        expect(() => nearestRank([], 50)).toThrow();
        expect(() => summarizeRuns([])).toThrow();
        const result = summarizeRuns([
            { kind: 'warm', firstAudioMs: 140, synthesisMs: 250, audioDurationSec: 2 },
            { kind: 'warm', firstAudioMs: 120, synthesisMs: 300, audioDurationSec: 2 },
            { kind: 'warm', firstAudioMs: 190, synthesisMs: 350, audioDurationSec: 2 },
        ]);
        expect(result).toMatchObject({
            kind: 'warm', runs: 3,
            firstAudioP50Ms: 140,
            firstAudioP95Ms: 190,
            realTimeFactorP50: 0.15,
        });
        expect(() => summarizeRuns([
            { kind: 'warm', firstAudioMs: 1, synthesisMs: 1, audioDurationSec: 1 },
            { kind: 'cold', firstAudioMs: 1, synthesisMs: 1, audioDurationSec: 1 },
            { kind: 'warm', firstAudioMs: 1, synthesisMs: 1, audioDurationSec: 1 },
        ])).toThrow();
    });
});
