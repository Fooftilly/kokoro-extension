/**
 * @jest-environment node
 */
const { ReadableStream } = require('stream/web');
const {
    readBoundedResponseText,
    PROGRESSIVE_HTTP_ERROR_BODY_LIMIT,
} = require('../mediasource-progressive-ttfa.js');

function textStream(chunks, { holdAfter = null } = {}) {
    let i = 0;
    let heldResolve;
    const held = holdAfter == null
        ? null
        : new Promise((resolve) => { heldResolve = resolve; });
    return {
        body: new ReadableStream({
            async pull(controller) {
                if (i >= chunks.length) {
                    if (held) await held;
                    controller.close();
                    return;
                }
                const chunk = chunks[i++];
                controller.enqueue(
                    typeof chunk === 'string'
                        ? new TextEncoder().encode(chunk)
                        : chunk);
                if (holdAfter != null && i === holdAfter) {
                    await held;
                }
            },
        }),
        releaseHold: () => heldResolve?.(),
    };
}

describe('readBoundedResponseText', () => {
    test('returns empty when response missing', async () => {
        expect(await readBoundedResponseText(null)).toBe('');
        expect(await readBoundedResponseText(undefined)).toBe('');
    });

    test('returns full short streamed body', async () => {
        const { body } = textStream(['rate limited']);
        expect(await readBoundedResponseText({ body })).toBe('rate limited');
    });

    test('stops at limit without waiting for stream EOF', async () => {
        const prefix = 'x'.repeat(PROGRESSIVE_HTTP_ERROR_BODY_LIMIT);
        const { body, releaseHold } = textStream(
            [prefix, 'TAIL_THAT_NEVER_ENDS'],
            { holdAfter: 1 });
        const pending = readBoundedResponseText({ body });
        // Must resolve while the stream is still held open after the limit.
        const out = await Promise.race([
            pending,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('waited for EOF')), 200)),
        ]);
        expect(out).toHaveLength(PROGRESSIVE_HTTP_ERROR_BODY_LIMIT);
        expect(out).toBe(prefix);
        releaseHold();
        await pending.catch(() => {});
    });

    test('honors pre-aborted signal without waiting for body', async () => {
        const controller = new AbortController();
        controller.abort();
        const { body, releaseHold } = textStream(
            ['never', 'delivered'],
            { holdAfter: 1 });
        const out = await Promise.race([
            readBoundedResponseText({ body }, 512, controller.signal),
            new Promise((_, reject) => setTimeout(
                () => reject(new Error('ignored abort')), 200)),
        ]);
        expect(out).toBe('');
        releaseHold();
    });

    test('falls back to text() when body missing', async () => {
        const response = { text: async () => 'gateway timeout' };
        expect(await readBoundedResponseText(response)).toBe('gateway timeout');
    });

    test('swallows text() rejection as empty string', async () => {
        const response = {
            text: async () => { throw new TypeError('body disturbed'); },
        };
        expect(await readBoundedResponseText(response)).toBe('');
    });
});
