/** @jest-environment node */
import { listModelVariants, manifestForVariant, dictionaryManifest,
    modelDataProvenance } from '../model-catalog.js';

describe('pinned model download provenance (#55)', () => {
    test.each(listModelVariants())('$key identifies its precise model repository and license', entry => {
        const manifest = manifestForVariant(entry.provider, entry.variant);
        const details = modelDataProvenance(manifest);
        expect(details.revision).toBe(manifest.revision);
        expect(details.name).toBe(entry.provider === 'mediapipe'
            ? 'litert-community/Kokoro-82M'
            : 'onnx-community/Kokoro-82M-v1.0-ONNX');
        expect(details.license).toBe('Apache-2.0');
        const prefix = 'https://huggingface.co/' + details.name + '/';
        expect(details.sourceUrl).toBe(prefix + 'tree/' + details.revision);
        expect(details.licenseUrl).toBe(prefix + 'blob/' + details.revision + '/README.md');
        expect(manifest.assets.every(asset => asset.url.includes(details.revision))).toBe(true);
        expect(entry.totalBytes).toBe(manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0));
    });

    test('dictionary links to its separately pinned CMUdict copyright notice', () => {
        const manifest = dictionaryManifest();
        const details = modelDataProvenance(manifest);
        expect(details).toEqual({
            name: 'cmusphinx/cmudict', revision: manifest.revision,
            sourceUrl: 'https://github.com/cmusphinx/cmudict/tree/' + manifest.revision,
            license: 'CMUdict permissive license',
            licenseUrl: 'https://github.com/cmusphinx/cmudict/blob/' + manifest.revision + '/LICENSE',
        });
    });

    test('refuses unknown source or unpinned source revision', () => {
        expect(() => modelDataProvenance({ provider: 'mediapipe', revision: 'b'.repeat(40) }))
            .toThrow(/Unknown pinned model-data source/);
        expect(() => modelDataProvenance({ provider: 'some-other-runtime', revision: 'a'.repeat(40) }))
            .toThrow(/Unknown pinned model-data source/);
        expect(() => modelDataProvenance({ provider: 'dictionary', revision: 'b'.repeat(40) }))
            .toThrow(/Unknown pinned model-data source/);
    });
});
