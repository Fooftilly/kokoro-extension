/** @jest-environment node */
/**
 * Contract for the shared EPUB 3 fixture used by Chromium and Firefox
 * offline reader acceptance (scripts/reader-acceptance-epub.mjs /
 * scripts/reader_acceptance_epub.py). Keep chapter labels and distinct
 * per-document speech bodies identical across both harnesses.
 *
 * Chromium builder coverage shells out to Node ESM so this CommonJS Jest
 * suite does not re-embed the ZIP fixture (Sonar new-code duplication gate).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scriptsDir = path.join(__dirname, '..', 'scripts');
const fixtureModule = path.join(scriptsDir, 'reader-acceptance-epub.mjs');

function expectedNames() {
    return [
        'META-INF/container.xml',
        'OEBPS/content.opf',
        'OEBPS/first.xhtml',
        'OEBPS/nav.xhtml',
        'OEBPS/second.xhtml',
        'mimetype',
    ].sort();
}

describe('reader acceptance EPUB fixture contract', () => {
    test('Chromium shared builder has distinct chapter speech and nav labels', () => {
        const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
import JSZip from 'jszip';
import { pathToFileURL } from 'node:url';
const mod = await import(pathToFileURL(${JSON.stringify(fixtureModule)}).href);
const { READER_ACCEPTANCE_SPEECH, buildReaderAcceptanceEpub } = mod;
const bytes = await buildReaderAcceptanceEpub();
const zip = await JSZip.loadAsync(bytes);
const names = Object.keys(zip.files).filter(name => !zip.files[name].dir).sort();
console.log(JSON.stringify({
    names,
    mime: await zip.file('mimetype').async('string'),
    nav: await zip.file('OEBPS/nav.xhtml').async('string'),
    first: await zip.file('OEBPS/first.xhtml').async('string'),
    second: await zip.file('OEBPS/second.xhtml').async('string'),
    speech: READER_ACCEPTANCE_SPEECH,
}));
`], { encoding: 'utf8', cwd: path.join(__dirname, '..') });
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const report = JSON.parse(result.stdout.trim());
        expect(report.names).toEqual(expectedNames());
        expect(report.mime).toBe('application/epub+zip');
        expect(report.nav).toContain('>First Chapter</a>');
        expect(report.nav).toContain('>Second Chapter</a>');
        expect(report.first).toContain(report.speech['First Chapter']);
        expect(report.second).toContain(report.speech['Second Chapter']);
        expect(report.speech['First Chapter']).not.toBe(report.speech['Second Chapter']);
        expect(report.speech['acceptance.txt']).not.toBe(report.speech['First Chapter']);
        expect(report.speech).toEqual({
            'First Chapter': 'Hello first chapter.',
            'Second Chapter': 'Hello second chapter.',
            'acceptance.txt': 'Hello plain text.',
        });
    });

    test('Firefox harness builder emits the same structural contract', () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kokoro-epub-fixture-'));
        const epubPath = path.join(tmp, 'offline-reader-acceptance.epub');
        const result = spawnSync('python3', ['-c', `
import json, sys, zipfile
sys.path.insert(0, ${JSON.stringify(scriptsDir)})
from reader_acceptance_epub import (
    READER_ACCEPTANCE_SPEECH, build_reader_acceptance_epub)
build_reader_acceptance_epub(${JSON.stringify(epubPath)})
with zipfile.ZipFile(${JSON.stringify(epubPath)}) as z:
    print(json.dumps({
        'names': sorted(z.namelist()),
        'mime': z.read('mimetype').decode(),
        'mimeStored': z.getinfo('mimetype').compress_type == zipfile.ZIP_STORED,
        'nav': z.read('OEBPS/nav.xhtml').decode(),
        'first': z.read('OEBPS/first.xhtml').decode(),
        'second': z.read('OEBPS/second.xhtml').decode(),
        'speech': READER_ACCEPTANCE_SPEECH,
    }))
`], { encoding: 'utf8' });
        fs.rmSync(tmp, { recursive: true, force: true });
        expect(result.status).toBe(0);
        expect(result.stderr || '').toBe('');
        const report = JSON.parse(result.stdout.trim());
        expect(report.mime).toBe('application/epub+zip');
        expect(report.mimeStored).toBe(true);
        expect(report.nav).toContain('>First Chapter</a>');
        expect(report.nav).toContain('>Second Chapter</a>');
        expect(report.speech).toEqual({
            'First Chapter': 'Hello first chapter.',
            'Second Chapter': 'Hello second chapter.',
            'acceptance.txt': 'Hello plain text.',
        });
        expect(report.first).toContain(report.speech['First Chapter']);
        expect(report.second).toContain(report.speech['Second Chapter']);
        expect(report.names).toEqual(expectedNames());
    });
});
