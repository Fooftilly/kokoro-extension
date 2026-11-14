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


def build_overlay_controls_report(options):
    out = _run_esm(
        "import { buildOverlayControlsReport } from "
        "'./overlay-controls-acceptance.mjs';"
        "console.log(JSON.stringify(buildOverlayControlsReport("
        + json.dumps(options) + ")));"
    )
    return json.loads(out)
