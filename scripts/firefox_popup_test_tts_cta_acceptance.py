"""Firefox popup Test TTS CTA — load shared ESM asserts via Node."""
import json
import subprocess
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent


def assert_popup_test_tts_surface(surface):
    """Run shared ESM assertPopupTestTtsSurface against a DOM snapshot."""
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { assertPopupTestTtsSurface } from "
            "'./popup-test-tts-cta-acceptance.mjs';"
            "assertPopupTestTtsSurface(" + json.dumps(surface) + ");"
            "console.log(JSON.stringify({ok:true}));",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "Popup CTA surface assert failed: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return True


def build_popup_cta_acceptance_report(benchmark_url):
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { buildPopupCtaAcceptanceReport } from "
            "'./popup-test-tts-cta-acceptance.mjs';"
            "console.log(JSON.stringify(buildPopupCtaAcceptanceReport("
            + json.dumps({"browser": "Firefox", "benchmarkUrl": benchmark_url})
            + ")));",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "Cannot build popup CTA report: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return json.loads(probe.stdout.strip())
