"""Pure Firefox EPUB/TXT acceptance routing helpers (no Selenium).

Used by validate-live-firefox.py and executable unit tests so backend
routing and distinct-WAV checks cannot silently drift into source-only
string contracts.

KE-50: firefox-mediapipe-origin EPUB uses the same shared three-spine
fixture path as ONNX (Third Chapter + four distinct WAV content hashes via
``assert_distinct_chapter_audio_hashes``). Nested TOC belongs to KE-49.
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


def assert_distinct_chapter_audio_hashes(
        first_sha, first_section_sha, second_sha, third_sha, txt_sha):
    """Fail closed when chapter/TXT WAV content hashes are missing or collide."""
    hashes = (first_sha, first_section_sha, second_sha, third_sha, txt_sha)
    if any(not isinstance(value, str) or not value for value in hashes):
        raise RuntimeError(
            "Reader WAV content hashes were missing across chapters/TXT: " +
            json.dumps({
                "first": first_sha, "firstSection": first_section_sha,
                "second": second_sha, "third": third_sha, "txt": txt_sha,
            }))
    if len(set(hashes)) != 5:
        raise RuntimeError(
            "Reader WAV content hashes were not distinct across chapters/TXT: " +
            json.dumps({
                "first": first_sha, "firstSection": first_section_sha,
                "second": second_sha, "third": third_sha, "txt": txt_sha,
            }))
    return True


READER_PROGRESS_ACCEPTANCE_STAGE = "offline-reader-progress-bookmarks-fencing"


def assert_lock_manager_available(available):
    """Packaged Firefox reader must expose navigator.locks.request (#196)."""
    if not available:
        raise RuntimeError(
            "Packaged reader requires navigator.locks.request for progress mutations")
    return True


def assert_bookmark_jump_did_not_autoplay(pending_autoplay):
    """Bookmark go-to must never start audio without explicit Play."""
    if pending_autoplay is True:
        raise RuntimeError("Bookmark go-to must keep pendingAutoplay false")
    return True


def assert_resume_banner_visible(hidden):
    """Resume banner must appear when prior progress exists for the same file."""
    if hidden:
        raise RuntimeError("Expected resume banner after reopening the same EPUB")
    return True


def assert_highlighted_block(text, expected_substring):
    """Fail closed when the restored highlight is not the saved nonzero block."""
    needle = str(expected_substring or "")
    if not needle or needle not in str(text or ""):
        raise RuntimeError(
            "Expected player highlight for saved block, got: " +
            json.dumps({"text": text, "expectedSubstring": needle}))
    return True


def assert_progress_cleared_or_first_chapter(record, first_href_needle):
    """Start over must drop the prior position (fresh first/block-0 allowed)."""
    if not record:
        return True
    href = str(record.get("chapterHref") or "")
    block_index = record.get("blockIndex")
    first_ok = (
        first_href_needle and first_href_needle in href and block_index == 0)
    if first_ok:
        return True
    raise RuntimeError(
        "Expected progress cleared or first-chapter block 0 after start over: " +
        json.dumps(record))


def build_progress_acceptance_report(
        *, locks_available, bookmark_added, bookmark_block_index,
        bookmark_go_restored_chapter, bookmark_go_restored_block,
        bookmark_go_suppressed_autoplay, bookmark_removed,
        stale_progress_fenced, resume_banner_after_reopen,
        resume_restored_chapter, resume_restored_block, resume_paused,
        progress_cleared_from_storage, resume_cleared):
    """Comparable Chromium/Firefox progress-stage report for #196."""
    return {
        "stage": READER_PROGRESS_ACCEPTANCE_STAGE,
        "locksAvailable": bool(locks_available),
        "bookmarkAdded": bool(bookmark_added),
        "bookmarkBlockIndex": (
            bookmark_block_index
            if isinstance(bookmark_block_index, int) else None),
        "bookmarkGoRestoredChapter": bookmark_go_restored_chapter or None,
        "bookmarkGoRestoredBlock": (
            bookmark_go_restored_block
            if isinstance(bookmark_go_restored_block, int) else None),
        "bookmarkGoSuppressedAutoplay": bool(bookmark_go_suppressed_autoplay),
        "bookmarkRemoved": bool(bookmark_removed),
        "staleProgressFenced": bool(stale_progress_fenced),
        "resumeBannerAfterReopen": bool(resume_banner_after_reopen),
        "resumeRestoredChapter": resume_restored_chapter or None,
        "resumeRestoredBlock": (
            resume_restored_block
            if isinstance(resume_restored_block, int) else None),
        "resumePaused": bool(resume_paused),
        "progressClearedFromStorage": bool(progress_cleared_from_storage),
        "resumeCleared": bool(resume_cleared),
    }
