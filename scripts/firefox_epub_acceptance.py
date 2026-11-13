"""Pure Firefox EPUB/TXT acceptance routing helpers (no Selenium).

Used by validate-live-firefox.py and executable unit tests so backend
routing and distinct-WAV checks cannot silently drift into source-only
string contracts.
"""
import json

ALLOWED_EPUB_BACKENDS = frozenset({"onnx", "mediapipe"})


def require_epub_backend(backend):
    """Return ``backend`` when it is onnx or mediapipe; else raise."""
    if backend not in ALLOWED_EPUB_BACKENDS:
        raise ValueError("EPUB reader acceptance requires onnx or mediapipe backend")
    return backend


def epub_backend_variant(backend):
    """Benchmark row data-variant for the active local EPUB backend."""
    require_epub_backend(backend)
    if backend == "onnx":
        return "onnx-q8"
    return "mediapipe-cpu"


def reader_storage_config(backend):
    """sync storage payload that selects the local TTS backend for reader.html."""
    require_epub_backend(backend)
    return {
        "ttsBackend": backend,
        "autoplayReader": False,
        "continuousReader": False,
        "mediaPipeVariant": "cpu",
        "localVoice": "af_heart",
    }


def origin_epub_stage_enabled(origin_download, provider, success):
    """Whether firefox-*-origin should run the real EPUB/TXT reader stage."""
    return bool(
        origin_download and provider in ALLOWED_EPUB_BACKENDS and success)


def assert_distinct_chapter_audio_hashes(first_sha, second_sha, txt_sha):
    """Fail closed when chapter/TXT WAV content hashes are missing or collide."""
    hashes = (first_sha, second_sha, txt_sha)
    if any(not isinstance(value, str) or not value for value in hashes):
        raise RuntimeError(
            "Reader WAV content hashes were missing across chapters/TXT: " +
            json.dumps({
                "first": first_sha, "second": second_sha, "txt": txt_sha,
            }))
    if len(set(hashes)) != 3:
        raise RuntimeError(
            "Reader WAV content hashes were not distinct across chapters/TXT: " +
            json.dumps({
                "first": first_sha, "second": second_sha, "txt": txt_sha,
            }))
    return True
