"""Firefox overlay controls — shared ESM asserts via Node."""
import json
import subprocess
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent


def _run_esm(expr):
    probe = subprocess.run(
        ["node", "--input-type=module", "-e", expr],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "Overlay controls ESM helper failed: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return probe.stdout.strip()


def overlay_seed_for_backend(backend, include_unsupported=False):
    out = _run_esm(
        "import { overlaySeedForBackend } from "
        "'./overlay-controls-acceptance.mjs';"
        "console.log(JSON.stringify(overlaySeedForBackend("
        + json.dumps(backend) + ", { includeUnsupported: "
        + json.dumps(include_unsupported) + " })));"
    )
    return json.loads(out)


def assert_overlay_wav_snapshot(snap):
    _run_esm(
        "import { assertOverlayWavSnapshot } from "
        "'./overlay-controls-acceptance.mjs';"
        "assertOverlayWavSnapshot(" + json.dumps(snap) + ");"
        "console.log(JSON.stringify({ok:true}));"
    )
    return True


def assert_overlay_settings(settings):
    _run_esm(
        "import { assertOverlaySettings } from "
        "'./overlay-controls-acceptance.mjs';"
        "assertOverlaySettings(" + json.dumps(settings) + ");"
        "console.log(JSON.stringify({ok:true}));"
    )
    return True


def expected_overlay_playing_status(sentence_index=0, sentence_count=3):
    out = _run_esm(
        "import { expectedOverlayPlayingStatus } from "
        "'./overlay-controls-acceptance.mjs';"
        "console.log(JSON.stringify(expectedOverlayPlayingStatus("
        + json.dumps(sentence_index) + ", " + json.dumps(sentence_count)
        + ")));"
    )
    return json.loads(out)


def assert_overlay_playback_confirmed(state):
    _run_esm(
        "import { assertOverlayPlaybackConfirmed } from "
        "'./overlay-controls-acceptance.mjs';"
        "assertOverlayPlaybackConfirmed(" + json.dumps(state) + ");"
        "console.log(JSON.stringify({ok:true}));"
    )
    return True


def assert_overlay_paused_after_toggle(state):
    _run_esm(
        "import { assertOverlayPausedAfterToggle } from "
        "'./overlay-controls-acceptance.mjs';"
        "assertOverlayPausedAfterToggle(" + json.dumps(state) + ");"
        "console.log(JSON.stringify({ok:true}));"
    )
    return True


def build_overlay_controls_report(options):
    out = _run_esm(
        "import { buildOverlayControlsReport } from "
        "'./overlay-controls-acceptance.mjs';"
        "console.log(JSON.stringify(buildOverlayControlsReport("
        + json.dumps(options) + ")));"
    )
    return json.loads(out)
