"""Pure Firefox article/selection acceptance routing helpers (no Selenium).

Used by validate-live-firefox.py and executable unit tests so backend
routing and distinct-WAV checks cannot silently drift into source-only
string contracts. Speech/fixture HTML stay owned by
article-selection-acceptance.mjs (shared with Chromium).
"""
import json
import subprocess
from pathlib import Path

ALLOWED_ARTICLE_SELECTION_BACKENDS = frozenset({"onnx", "mediapipe"})

_SCRIPTS_DIR = Path(__file__).resolve().parent


def require_article_selection_backend(backend):
    """Return ``backend`` when it is onnx or mediapipe; else raise."""
    if backend not in ALLOWED_ARTICLE_SELECTION_BACKENDS:
        raise ValueError(
            "Article/selection acceptance requires onnx or mediapipe backend, got: " +
            repr(backend))
    return backend


def article_selection_storage_config(backend):
    """sync storage payload that enables floating mic + local ONNX/MediaPipe TTS."""
    require_article_selection_backend(backend)
    return {
        "ttsBackend": backend,
        "showFloatingButton": True,
        "mediaPipeVariant": "cpu",
        "localVoice": "af_heart",
        "mode": "stream",
        "apiUrl": "",
    }


def origin_article_selection_stage_enabled(origin_download, provider, success):
    """Whether firefox-*-origin should run real article/selection for onnx/mediapipe."""
    return bool(
        origin_download and
        provider in ALLOWED_ARTICLE_SELECTION_BACKENDS and
        success)


def assert_distinct_article_selection_audio_hashes(selection_sha, article_sha):
    """Fail closed when selection/article WAV content hashes are missing or collide."""
    if not selection_sha or not article_sha:
        raise RuntimeError(
            "Article/selection WAV content hashes were missing: " +
            json.dumps({"selection": selection_sha, "article": article_sha}))
    if selection_sha == article_sha:
        raise RuntimeError(
            "Article/selection WAV content hashes collided: " +
            json.dumps({"selection": selection_sha, "article": article_sha}))
    return True


def load_article_selection_fixture():
    """Load fixture HTML + speech from the shared Chromium/Firefox ESM module."""
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { pathToFileURL } from 'node:url';"
            "import { buildArticleSelectionFixtureHtml, ARTICLE_SELECTION_SPEECH }"
            " from './article-selection-acceptance.mjs';"
            "console.log(JSON.stringify({"
            " html: buildArticleSelectionFixtureHtml(),"
            " speech: ARTICLE_SELECTION_SPEECH"
            "}));",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "Cannot load article-selection fixture from ESM: " +
            (probe.stderr or probe.stdout or "unknown error"))
    payload = json.loads(probe.stdout.strip())
    if not isinstance(payload.get("html"), str) or not payload.get("speech"):
        raise RuntimeError(
            "Article-selection fixture payload malformed: " + probe.stdout[:200])
    return payload
