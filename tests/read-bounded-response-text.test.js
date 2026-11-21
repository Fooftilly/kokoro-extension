/**
 * @jest-environment node
 */
const {
    readBoundedResponseText,
    PROGRESSIVE_HTTP_ERROR_BODY_LIMIT,
} = require('../mediasource-progressive-ttfa.js');

describe('readBoundedResponseText', () => {
    test('returns empty when response missing', async () => {
        expect(await readBoundedResponseText(null)).toBe('');
        expect(await readBoundedResponseText(undefined)).toBe('');
    });

    test('returns full short body', async () => {
        const response = { text: async () => 'rate limited' };
        expect(await readBoundedResponseText(response)).toBe('rate limited');
    });

    test('truncates long body to limit', async () => {
        const long = 'x'.repeat(PROGRESSIVE_HTTP_ERROR_BODY_LIMIT + 40);
        const response = { text: async () => long };
        const out = await readBoundedResponseText(response);
        expect(out).toHaveLength(PROGRESSIVE_HTTP_ERROR_BODY_LIMIT);
        expect(out).toBe(long.slice(0, PROGRESSIVE_HTTP_ERROR_BODY_LIMIT));
    });

    test('swallows text() rejection as empty string', async () => {
        const response = {
            text: async () => { throw new TypeError('body disturbed'); },
        };
        expect(await readBoundedResponseText(response)).toBe('');
    });
});
