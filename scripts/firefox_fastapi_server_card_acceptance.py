"""Firefox FastAPI server-card — load shared ESM asserts via Node."""
import json
import subprocess
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent


def build_fastapi_server_card_report(
        api_url, browser="Firefox", backend_before_choose="mediapipe",
        choose_changed_backend=True, audio_duration_sec=None,
        streaming_first_body_byte_measured=True,
        playback_start_measured=True,
        first_body_byte_p50_ms=None, synthesis_p50_ms=None,
        playback_start_p50_ms=None):
    """Build the same report shape Chromium uses after a successful card test."""
    options = {
        "browser": browser,
        "apiUrl": api_url,
        "afterLocalDualComparison": True,
        "backendBeforeChoose": backend_before_choose,
        "chooseChangedBackend": choose_changed_backend,
        "decodeableMp3": True,
        "audioDurationSec": audio_duration_sec,
        "streamingFirstBodyByteMeasured": streaming_first_body_byte_measured,
        "playbackStartMeasured": playback_start_measured,
    }
    if first_body_byte_p50_ms is not None:
        options["firstBodyByteP50Ms"] = first_body_byte_p50_ms
    if synthesis_p50_ms is not None:
        options["synthesisP50Ms"] = synthesis_p50_ms
    if playback_start_p50_ms is not None:
        options["playbackStartP50Ms"] = playback_start_p50_ms
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { buildFastApiServerCardReport } from "
            "'./fastapi-server-card-acceptance.mjs';"
            "console.log(JSON.stringify(buildFastApiServerCardReport("
            + json.dumps(options)
            + ")));",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "Cannot build FastAPI server-card report: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return json.loads(probe.stdout.strip())


def assert_fastapi_server_card_report(report):
    """Fail closed if the report shape drifts from the shared ESM contract."""
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { assertFastApiServerCardReport } from "
            "'./fastapi-server-card-acceptance.mjs';"
            "assertFastApiServerCardReport(" + json.dumps(report) + ");"
            "console.log(JSON.stringify({ok:true}));",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "FastAPI server-card assert failed: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return True
