// Portable capability and measurement helpers, without model downloads or network activity.
(function () {
    'use strict';

    function adapterDetails(adapter) {
        return {
            status: 'adapter-available',
            features: Array.from(adapter.features || []),
            limits: adapter.limits ? {
                maxBufferSize: adapter.limits.maxBufferSize ?? null,
                maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize ?? null,
            } : null,
        };
    }

    async function inspectWebGPU(nav) {
        if (!nav.gpu || typeof nav.gpu.requestAdapter !== 'function') {
            return { status: 'not-exposed' };
        }
        try {
            const adapter = await nav.gpu.requestAdapter();
            return adapter ? adapterDetails(adapter) : { status: 'no-adapter' };
        } catch (error) {
            return {
                status: 'request-failed',
                error: String(error && error.message || error),
            };
        }
    }

    async function inspectCapabilities(environment) {
        const env = environment || globalThis;
        const nav = env.navigator || {};
        const hasWasm = !!(env.WebAssembly && typeof env.WebAssembly.compile === 'function');
        const isolated = env.crossOriginIsolated === true;
        const sharedMemory = typeof env.SharedArrayBuffer === 'function';
        return {
            kind: 'capability-preflight',
            schemaVersion: 1,
            checkedAt: new Date().toISOString(),
            browser: String(nav.userAgent || 'unknown'),
            secureContext: env.isSecureContext === true,
            wasmCompilation: hasWasm,
            crossOriginIsolated: isolated,
            sharedArrayBuffer: sharedMemory,
            wasmThreadsPrerequisites: hasWasm && isolated && sharedMemory,
            webgpu: await inspectWebGPU(nav),
            inferenceValidated: false,
            offlineModelValidated: false,
        };
    }

    function nearestRank(values, percentile) {
        if (!Array.isArray(values) || values.length === 0 ||
            !values.every(value => Number.isFinite(value) && value >= 0)) {
            throw new TypeError('Expected at least one finite, nonnegative measurement');
        }
        if (!(percentile > 0 && percentile <= 100)) {
            throw new RangeError('Invalid percentile');
        }
        const sorted = values.slice().sort((a, b) => a - b);
        return sorted[Math.ceil(percentile * sorted.length / 100) - 1];
    }

    // Called only with actual synthesized samples measured by a future engine.
    function summarizeRuns(runs) {
        if (!Array.isArray(runs) || runs.length < 3) {
            throw new RangeError('At least three completed real inference runs are required');
        }
        const kind = runs[0].kind;
        if (kind !== 'cold' && kind !== 'warm') {
            throw new RangeError('Runs must declare cold or warm initialization');
        }
        for (const run of runs) {
            if (run.kind !== kind ||
                !Number.isFinite(run.firstAudioMs) || run.firstAudioMs < 0 ||
                !Number.isFinite(run.synthesisMs) || run.synthesisMs < 0 ||
                !Number.isFinite(run.audioDurationSec) || run.audioDurationSec <= 0) {
                throw new TypeError('Invalid, mixed, or synthetic inference measurements');
            }
        }
        return {
            kind,
            runs: runs.length,
            firstAudioP50Ms: nearestRank(runs.map(r => r.firstAudioMs), 50),
            firstAudioP95Ms: nearestRank(runs.map(r => r.firstAudioMs), 95),
            realTimeFactorP50: nearestRank(
                runs.map(r => r.synthesisMs / (1000 * r.audioDurationSec)), 50),
            realTimeFactorP95: nearestRank(
                runs.map(r => r.synthesisMs / (1000 * r.audioDurationSec)), 95),
        };
    }

    const api = { inspectCapabilities, nearestRank, summarizeRuns };
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.KokoroBenchmark = api;
    }
})();
