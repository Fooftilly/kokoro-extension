/**
 * Chromium article/selection live-acceptance helpers and HTML fixture.
 * Keep speech strings aligned with tests/article-selection-acceptance.test.js.
 */

export const ARTICLE_SELECTION_SPEECH = {
    selection: 'Hello selected text.',
    articleFirst: 'Hello first article paragraph.',
    articleSecond: 'Hello second article paragraph.',
    articleTitle: 'Kokoro Article Acceptance',
};

export const ALLOWED_ARTICLE_SELECTION_BACKENDS = Object.freeze([
    'onnx', 'mediapipe',
]);

export function requireArticleSelectionBackend(backend) {
    if (!ALLOWED_ARTICLE_SELECTION_BACKENDS.includes(backend)) {
        throw new Error(
            'Article/selection acceptance requires onnx or mediapipe backend, got: ' +
            String(backend));
    }
    return backend;
}

export function originArticleSelectionStageEnabled(originDownload, provider, success) {
    return Boolean(
        originDownload &&
        ALLOWED_ARTICLE_SELECTION_BACKENDS.includes(provider) &&
        success);
}

export function assertDistinctArticleSelectionAudioHashes(selectionSha, articleSha) {
    if (!selectionSha || !articleSha) {
        throw new Error(
            'Article/selection WAV content hashes were missing: ' +
            JSON.stringify({ selection: selectionSha, article: articleSha }));
    }
    if (selectionSha === articleSha) {
        throw new Error(
            'Article/selection WAV content hashes collided: ' +
            JSON.stringify({ selection: selectionSha, article: articleSha }));
    }
    return true;
}

export function articleSelectionStorageConfig(backend) {
    requireArticleSelectionBackend(backend);
    return {
        ttsBackend: backend,
        showFloatingButton: true,
        mediaPipeVariant: 'cpu',
        localVoice: 'af_heart',
        mode: 'stream',
        apiUrl: '',
    };
}

/** Minimal Readability-friendly article page for content-script acceptance. */
export function buildArticleSelectionFixtureHtml() {
    const {
        selection, articleFirst, articleSecond, articleTitle,
    } = ARTICLE_SELECTION_SPEECH;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <title>${articleTitle}</title>
  <meta name="description" content="Offline article and selection acceptance fixture"/>
</head>
<body>
  <header><p>Site chrome that Readability should ignore.</p></header>
  <main>
    <article>
      <h1>${articleTitle}</h1>
      <p id="selection-sentence">${selection}</p>
      <p id="article-first">${articleFirst}</p>
      <p id="article-second">${articleSecond}</p>
    </article>
  </main>
  <aside><p>Related links sidebar.</p></aside>
</body>
</html>`;
}
