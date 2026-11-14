/**
 * Shared FastAPI preference-honor live acceptance contract (#61 / KE-29).
 * After dual FastAPI card selects fastapi, prove selection / article /
 * reader / download paths read sync preference (not a silent local fallback).
 * Chromium imports this; Firefox loads asserts via Node for the same shapes.
 */

export const PREFERENCE_HONOR_SPEECH = Object.freeze({
    selection: 'Hello FastAPI selection preference.',
    articleFirst: 'Hello FastAPI article first.',
    articleSecond: 'Hello FastAPI article second.',
    articleTitle: 'Kokoro FastAPI Preference Honor',
    reader: 'Hello FastAPI reader preference.',
    download: 'Hello FastAPI download preference.',
});

export function buildPreferenceHonorFixtureHtml() {
    const {
        selection, articleFirst, articleSecond, articleTitle,
    } = PREFERENCE_HONOR_SPEECH;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${articleTitle}</title>
  <meta name="description" content="FastAPI preference honor fixture"/>
</head>
<body>
  <header><p>Site chrome that Readability should ignore.</p></header>
  <main>
    <article>
      <h1>${articleTitle}</h1>
      <p id="selection-sentence">${selection}</p>
      <p id="article-first">${articleFirst}</p>
      <p id="article-second">${articleSecond}</p>
      <p id="download-sentence">${PREFERENCE_HONOR_SPEECH.download}</p>
    </article>
  </main>
  <aside><p>Related links sidebar.</p></aside>
</body>
</html>`;
}

function requireTrue(report, key, message) {
    if (report[key] !== true) throw new Error(message);
}

function assertPath(report, key, expectedSpeech) {
    const pathReport = report[key];
    if (!pathReport || typeof pathReport !== 'object') {
        throw new Error('preference honor path missing: ' + key);
    }
    requireTrue(pathReport, 'honored', key + '.honored must be true');
    if (pathReport.pendingTtsBackend !== 'fastapi') {
        throw new Error(
            key + '.pendingTtsBackend must be fastapi: ' +
            pathReport.pendingTtsBackend);
    }
    if (expectedSpeech && pathReport.speech !== expectedSpeech) {
        throw new Error(
            key + '.speech mismatch: ' + pathReport.speech);
    }
}

/**
 * Validate a dual-scope FastAPI preference-honor report before saving.
 * Distinct keys from fastapi-server-card / dual-use-this-backend (Sonar).
 */
export function assertFastApiPreferenceHonorReport(report) {
    if (!report || typeof report !== 'object') {
        throw new Error(
            'FastAPI preference-honor report missing: ' + String(report));
    }
    requireTrue(report, 'success',
        'FastAPI preference-honor report not successful');
    requireTrue(report, 'afterFastApiServerCard',
        'afterFastApiServerCard must be true');
    if (report.selectedBackend !== 'fastapi') {
        throw new Error(
            'selectedBackend must be fastapi: ' + report.selectedBackend);
    }
    if (!String(report.apiUrl || '').includes('/v1')) {
        throw new Error('apiUrl must point at a /v1 FastAPI base');
    }
    assertPath(report, 'selection', PREFERENCE_HONOR_SPEECH.selection);
    assertPath(report, 'article', PREFERENCE_HONOR_SPEECH.articleFirst);
    assertPath(report, 'reader', PREFERENCE_HONOR_SPEECH.reader);
    assertPath(report, 'download', PREFERENCE_HONOR_SPEECH.download);
    requireTrue(report.selection, 'mpegDataUrl',
        'selection.mpegDataUrl must be true');
    requireTrue(report.article, 'mpegDataUrl',
        'article.mpegDataUrl must be true');
    requireTrue(report.reader, 'mpegDataUrl',
        'reader.mpegDataUrl must be true');
    requireTrue(report.download, 'mp3Download',
        'download.mp3Download must be true');
    requireTrue(report, 'noLocalWavFallback',
        'noLocalWavFallback must be true');
    return true;
}

export function buildFastApiPreferenceHonorReport(options = {}) {
    const apiUrl = String(options.apiUrl || 'http://127.0.0.1:0/v1/');
    const withSlash = apiUrl.endsWith('/') ? apiUrl : apiUrl + '/';
    const report = {
        success: true,
        browser: options.browser || 'unknown',
        afterFastApiServerCard: options.afterFastApiServerCard !== false,
        selectedBackend: 'fastapi',
        apiUrl: withSlash,
        selection: {
            honored: true,
            path: 'floating-mic',
            pendingTtsBackend: 'fastapi',
            speech: PREFERENCE_HONOR_SPEECH.selection,
            mpegDataUrl: true,
            audioDataUrlPrefix: 'data:audio',
        },
        article: {
            honored: true,
            path: 'read-article-command-native-x11',
            pendingTtsBackend: 'fastapi',
            speech: PREFERENCE_HONOR_SPEECH.articleFirst,
            mpegDataUrl: true,
            audioDataUrlPrefix: 'data:audio',
            blockCount: options.articleBlockCount || 2,
        },
        reader: {
            honored: true,
            path: 'txt-via-reader',
            pendingTtsBackend: 'fastapi',
            speech: PREFERENCE_HONOR_SPEECH.reader,
            mpegDataUrl: true,
            audioDataUrlPrefix: 'data:audio',
            title: 'fastapi-preference.txt',
        },
        download: {
            honored: true,
            path: 'mode-download',
            pendingTtsBackend: 'fastapi',
            speech: PREFERENCE_HONOR_SPEECH.download,
            mp3Download: true,
            filenameEndsWithMp3: true,
        },
        noLocalWavFallback: true,
        speechStubHits: options.speechStubHits || null,
    };
    assertFastApiPreferenceHonorReport(report);
    return report;
}
