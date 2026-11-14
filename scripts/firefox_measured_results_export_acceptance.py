"""Firefox dual measured-results export — load shared ESM asserts via Node."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
_BRIDGE = _SCRIPTS_DIR / "measured-results-export-node-bridge.mjs"
_EXPORT_FILENAME = "kokoro-measured-local-english.json"


def _parse_bridge_stdout(probe):
    if probe.returncode != 0:
        raise RuntimeError(
            "Measured export Node helper failed: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return json.loads(probe.stdout.strip() or "null")


def measured_export_constants():
    """Constants shared with Chromium measured-export acceptance."""
    probe = subprocess.run(
        ["node", str(_BRIDGE), "constants"],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    return _parse_bridge_stdout(probe)


def assert_measured_results_export_payload(payload, expected=None):
    """Assert local-only measured export payload shape."""
    expected = expected or {}
    probe = subprocess.run(
        ["node", str(_BRIDGE), "assert-payload"],
        input=json.dumps({"payload": payload, "expected": expected}),
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    return _parse_bridge_stdout(probe)


def build_measured_results_export_report(**options):
    """Build the same report shape Chromium uses after measured export.

    Pure Python mirror of buildMeasuredResultsExportReport — avoids a Node
    round-trip that Sonar flagged as sensitive stdout disclosure.
    """
    return {
        "success": options.get("success", True) is not False,
        "browser": options.get("browser") or "chromium",
        "localOnly": True,
        "telemetry": False,
        "noRanking": True,
        "filename": _EXPORT_FILENAME,
        "keys": options.get("keys") or ["onnx-q8", "mediapipe-cpu"],
        "sampleText": options.get("sampleText") or "Hello world.",
        "statusConfirmed": options.get("statusConfirmed", True) is not False,
        "downloadTriggered": options.get("downloadTriggered", True) is not False,
        "fileContentsVerified": options.get("fileContentsVerified") is True,
    }


def assert_measured_results_export_report(report):
    """Reject incomplete measured export reports."""
    probe = subprocess.run(
        ["node", str(_BRIDGE), "assert-report"],
        input=json.dumps(report),
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    return _parse_bridge_stdout(probe)
