"""Firefox long-form memory acceptance — load shared ESM helpers + Python asserts.

Speech/storage/visit indexes stay owned by long-form-memory-acceptance.mjs
(Chromium). Pure bound checks are ported here so Selenium can call them
without a Node round-trip on every sentence click.
"""
import json
import subprocess
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent

# Keep in sync with scripts/long-form-memory-acceptance.mjs
LONG_FORM_SENTENCE_COUNT = 24
LONG_FORM_MAX_CACHE_ENTRIES = 8
LONG_FORM_MAX_OBJECT_URLS = 8
ALLOWED_LONG_FORM_BACKENDS = frozenset({"onnx"})


def require_long_form_backend(backend):
    if backend not in ALLOWED_LONG_FORM_BACKENDS:
        raise ValueError(
            "Long-form memory acceptance requires onnx backend, got: " +
            repr(backend))
    return backend


def origin_long_form_memory_stage_enabled(origin_download, provider, success):
    return bool(
        origin_download and
        provider in ALLOWED_LONG_FORM_BACKENDS and
        success)


def load_long_form_fixture(backend="onnx"):
    """Load storage config + visit indexes from the shared Chromium ESM module.

    Storage includes pendingAcceptanceProbe so overlay.js exposes
    window.__kokoroAudioManagerStats for the Selenium walk.
    """
    require_long_form_backend(backend)
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import {"
            "  LONG_FORM_SENTENCE_COUNT,"
            "  buildLongFormVisitIndexes,"
            "  longFormStorageConfig,"
            "} from './long-form-memory-acceptance.mjs';"
            "const storage = longFormStorageConfig(" + json.dumps(backend) + ");"
            "console.log(JSON.stringify({"
            "  sentenceCount: LONG_FORM_SENTENCE_COUNT,"
            "  storage,"
            "  visits: buildLongFormVisitIndexes(),"
            "}));",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "Cannot load long-form fixture from ESM: " +
            (probe.stderr or probe.stdout or "unknown error"))
    payload = json.loads(probe.stdout.strip())
    if (payload.get("sentenceCount") != LONG_FORM_SENTENCE_COUNT or
            not isinstance(payload.get("storage"), dict) or
            not isinstance(payload.get("visits"), list)):
        raise RuntimeError(
            "Long-form fixture payload malformed: " + probe.stdout[:200])
    if LONG_FORM_SENTENCE_COUNT - 1 in payload["visits"]:
        raise RuntimeError(
            "Visit path must not already end on the distant-jump target")
    return payload


def assert_bounded_audio_manager_stats(stats, options=None):
    options = options or {}
    max_cache = options.get("maxCacheEntries", LONG_FORM_MAX_CACHE_ENTRIES)
    max_urls = options.get("maxObjectUrls", LONG_FORM_MAX_OBJECT_URLS)
    min_sentences = options.get("minSentences", LONG_FORM_SENTENCE_COUNT)
    if not isinstance(stats, dict):
        raise RuntimeError(
            "AudioManager acceptance probe missing: " + repr(stats))
    if (not isinstance(stats.get("sentenceCount"), int) or
            stats["sentenceCount"] < min_sentences):
        raise RuntimeError(
            "Long-form sentence count too small: " + json.dumps(stats))
    if (not isinstance(stats.get("cacheSize"), int) or
            stats["cacheSize"] > max_cache):
        raise RuntimeError(
            "AudioManager cache exceeded bound: " +
            json.dumps({"cacheSize": stats.get("cacheSize"),
                        "maxCache": max_cache, "stats": stats}))
    if (not isinstance(stats.get("objectUrlCount"), int) or
            stats["objectUrlCount"] > max_urls):
        raise RuntimeError(
            "AudioManager object URLs exceeded bound: " +
            json.dumps({"objectUrlCount": stats.get("objectUrlCount"),
                        "maxUrls": max_urls, "stats": stats}))
    return True


def assert_long_form_cache_window_near(stats, center, behind=2, ahead=2):
    window = stats.get("window") if isinstance(stats, dict) else None
    if (not isinstance(window, dict) or
            not isinstance(window.get("first"), int) or
            not isinstance(window.get("last"), int)):
        raise RuntimeError(
            "Cache window missing after navigation: " + json.dumps(stats))
    if window["first"] > center or window["last"] < center:
        raise RuntimeError(
            "Cache window does not cover active sentence: " +
            json.dumps({"center": center, "window": window,
                        "behind": behind, "ahead": ahead}))
    if window["last"] - window["first"] > behind + ahead:
        raise RuntimeError(
            "Cache window wider than retainWindow bound: " +
            json.dumps({"window": window, "behind": behind, "ahead": ahead}))
    return True


def assert_long_form_heap_delta(before_bytes, after_bytes,
                                max_growth_bytes=256 * 1024 * 1024):
    if not (isinstance(before_bytes, (int, float)) and
            isinstance(after_bytes, (int, float))):
        raise RuntimeError(
            "Heap samples missing: " +
            json.dumps({"beforeBytes": before_bytes, "afterBytes": after_bytes}))
    growth = after_bytes - before_bytes
    if growth > max_growth_bytes:
        raise RuntimeError(
            "Long-form JS heap growth exceeded bound: " +
            json.dumps({"beforeBytes": before_bytes, "afterBytes": after_bytes,
                        "growth": growth, "maxGrowthBytes": max_growth_bytes}))
    return {"growth": growth, "maxGrowthBytes": max_growth_bytes}
