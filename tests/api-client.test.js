/**
 * @jest-environment jsdom
 */

const {
    normalizeVoiceEntry,
    normalizeVoiceIds,
    filterVoicesByPrefix,
    parseVoicesResponse,
    classifyApiFailure,
    fetchNormalizedVoices,
    probeApiConnection,
} = require('../api-client.js');

describe('normalizeVoiceEntry / normalizeVoiceIds (#6)', () => {
    test('legacy string voices pass through', () => {
        expect(normalizeVoiceIds(['af_alloy', 'bm_george'])).toEqual(['af_alloy', 'bm_george']);
    });

    test('object voices use id', () => {
        expect(normalizeVoiceIds([
            { id: 'af_alloy', name: 'af_alloy' },
            { id: 'af_aoede', name: 'af_aoede' },
        ])).toEqual(['af_alloy', 'af_aoede']);
    });

    test('object voices fall back to name when id missing', () => {
        expect(normalizeVoiceEntry({ name: 'bf_emma' })).toBe('bf_emma');
        expect(normalizeVoiceIds([{ name: 'bf_emma' }, { id: 'am_adam' }])).toEqual([
            'bf_emma',
            'am_adam',
        ]);
    });

    test('mixed string + object entries', () => {
        expect(normalizeVoiceIds([
            'af_sarah',
            { id: 'af_nicole', name: 'af_nicole' },
            'bm_lewis',
        ])).toEqual(['af_sarah', 'af_nicole', 'bm_lewis']);
    });

    test('malformed entries are filtered without throwing', () => {
        expect(normalizeVoiceIds([
            null,
            undefined,
            42,
            {},
            { id: null },
            { id: '' },
            { name: 7 },
            '  ',
            'af_sky',
            { id: '  am_echo  ' },
        ])).toEqual(['af_sky', 'am_echo']);
    });

    test('missing / non-array voices do not crash', () => {
        expect(normalizeVoiceIds(undefined)).toEqual([]);
        expect(normalizeVoiceIds(null)).toEqual([]);
        expect(normalizeVoiceIds({ id: 'af_alloy' })).toEqual([]);
        expect(normalizeVoiceIds('af_alloy')).toEqual([]);
        expect(parseVoicesResponse(undefined)).toEqual({ voices: [], shapeOk: false });
        expect(parseVoicesResponse({})).toEqual({ voices: [], shapeOk: false });
        expect(parseVoicesResponse({ voices: null })).toEqual({ voices: [], shapeOk: false });
        expect(parseVoicesResponse({ voices: 'af_alloy' })).toEqual({ voices: [], shapeOk: false });
    });

    test('prefix filtering still works after normalization', () => {
        const ids = normalizeVoiceIds([
            { id: 'af_alloy' },
            { id: 'zf_other' },
            'am_adam',
            'xx_skip',
            { name: 'bf_emma' },
            { id: 'bm_george' },
        ]);
        expect(filterVoicesByPrefix(ids)).toEqual([
            'af_alloy',
            'am_adam',
            'bf_emma',
            'bm_george',
        ]);
    });
});

describe('parseVoicesResponse', () => {
    test('legacy string payload', () => {
        expect(parseVoicesResponse({
            voices: ['af_alloy', 'zf_skip', 'bm_george'],
        })).toEqual({
            voices: ['af_alloy', 'bm_george'],
            shapeOk: true,
        });
    });

    test('object payload (Kokoro-FastAPI >= 0.3)', () => {
        expect(parseVoicesResponse({
            voices: [
                { id: 'af_alloy', name: 'af_alloy' },
                { id: 'zf_skip', name: 'zf_skip' },
            ],
        })).toEqual({
            voices: ['af_alloy'],
            shapeOk: true,
        });
    });
});

describe('fetchNormalizedVoices (#6 + #4 error kinds)', () => {
    test('legacy strings → ok', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ voices: ['af_alloy', 'bm_george'] }),
        });
        const result = await fetchNormalizedVoices('http://127.0.0.1:8880/v1/', fetchImpl);
        expect(result.ok).toBe(true);
        expect(result.kind).toBe('ok');
        expect(result.voices).toEqual(['af_alloy', 'bm_george']);
        expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8880/v1/audio/voices');
    });

    test('object response → ok', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                voices: [
                    { id: 'af_alloy', name: 'af_alloy' },
                    { id: 'af_aoede', name: 'af_aoede' },
                ],
            }),
        });
        const result = await fetchNormalizedVoices('http://127.0.0.1:8880/v1/', fetchImpl);
        expect(result.ok).toBe(true);
        expect(result.kind).toBe('ok');
        expect(result.voices).toEqual(['af_alloy', 'af_aoede']);
    });

    test('mixed + malformed entries still succeed', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                voices: ['af_sarah', null, { id: 'bm_lewis' }, { bad: true }],
            }),
        });
        const result = await fetchNormalizedVoices('http://x/v1/', fetchImpl);
        expect(result.ok).toBe(true);
        expect(result.voices).toEqual(['af_sarah', 'bm_lewis']);
    });

    test('missing voices key → malformed (not network)', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ models: [] }),
        });
        const result = await fetchNormalizedVoices('http://x/v1/', fetchImpl);
        expect(result.ok).toBe(false);
        expect(result.kind).toBe('malformed');
        expect(result.message).not.toMatch(/reach/i);
    });

    test('non-array voices → malformed', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ voices: { id: 'af_alloy' } }),
        });
        const result = await fetchNormalizedVoices('http://x/v1/', fetchImpl);
        expect(result.kind).toBe('malformed');
    });

    test('invalid JSON → malformed', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => {
                throw new SyntaxError('Unexpected token');
            },
        });
        const result = await fetchNormalizedVoices('http://x/v1/', fetchImpl);
        expect(result.kind).toBe('malformed');
        expect(result.message).toMatch(/unsupported|format/i);
    });

    test('HTTP error → http kind', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: false,
            status: 502,
            json: async () => ({}),
        });
        const result = await fetchNormalizedVoices('http://x/v1/', fetchImpl);
        expect(result.kind).toBe('http');
        expect(result.message).toMatch(/HTTP/i);
    });

    test('fetch rejection → network kind', async () => {
        const fetchImpl = jest.fn().mockRejectedValue(new TypeError('Failed to fetch'));
        const result = await fetchNormalizedVoices('http://x/v1/', fetchImpl);
        expect(result.kind).toBe('network');
        expect(result.message).toMatch(/reach/i);
    });

    test('empty after prefix filter → empty kind (success path)', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ voices: ['zf_only', { id: 'xx_nope' }] }),
        });
        const result = await fetchNormalizedVoices('http://x/v1/', fetchImpl);
        expect(result.ok).toBe(true);
        expect(result.kind).toBe('empty');
        expect(result.voices).toEqual([]);
    });
});

describe('probeApiConnection (#4)', () => {
    test('success', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ status: 'ok' }),
        });
        const result = await probeApiConnection('http://127.0.0.1:8880/v1/', fetchImpl);
        expect(result).toEqual({
            ok: true,
            kind: 'ok',
            message: expect.stringMatching(/connected/i),
        });
        expect(fetchImpl).toHaveBeenCalledWith(
            'http://127.0.0.1:8880/v1/test',
            expect.objectContaining({ method: 'GET' })
        );
    });

    test('network failure', async () => {
        const fetchImpl = jest.fn().mockRejectedValue(new TypeError('NetworkError'));
        const result = await probeApiConnection('http://bad/', fetchImpl);
        expect(result.ok).toBe(false);
        expect(result.kind).toBe('network');
    });

    test('HTTP error', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 500 });
        const result = await probeApiConnection('http://x/v1/', fetchImpl);
        expect(result.kind).toBe('http');
    });

    test('bad shape is not labeled unreachable', async () => {
        const fetchImpl = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({ status: 'weird' }),
        });
        const result = await probeApiConnection('http://x/v1/', fetchImpl);
        expect(result.kind).toBe('malformed');
        expect(result.message).not.toMatch(/Unable to reach/i);
    });
});

describe('classifyApiFailure', () => {
    test('maps known shapes', () => {
        expect(classifyApiFailure(new TypeError('fail'))).toBe('network');
        const httpErr = new Error('x');
        httpErr.kind = 'http';
        expect(classifyApiFailure(httpErr)).toBe('http');
        expect(classifyApiFailure(new SyntaxError('bad json'))).toBe('malformed');
    });
});
