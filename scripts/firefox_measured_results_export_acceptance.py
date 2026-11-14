"""Firefox dual measured-results export — load shared ESM asserts via Node."""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent
_BRIDGE = _SCRIPTS_DIR / "measured-results-export-node-bridge.mjs"


def _write_json_temp(data):
    handle = tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, encoding="utf-8")
    try:
        json.dump(data, handle)
        handle.close()
        return handle.name
    except Exception:
        handle.close()
        Path(handle.name).unlink(missing_ok=True)
        raise


def _parse_bridge_stdout(probe):
    if probe.returncode != 0:
        raise RuntimeError(
            "Measured export Node helper failed: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return json.loads(probe.stdout.strip() or "null")


def measured_export_constants():
    """Constants shared with Chromium measured-export acceptance."""
    # List literal keeps Sourcery dangerous-subprocess-use-audit quiet.
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
    tmp_path = _write_json_temp({"payload": payload, "expected": expected})
    try:
        probe = subprocess.run(
            ["node", str(_BRIDGE), "assert-payload", tmp_path],
            cwd=str(_SCRIPTS_DIR),
            capture_output=True,
            text=True,
            check=False,
        )
        return _parse_bridge_stdout(probe)
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def build_measured_results_export_report(**options):
    """Build the same report shape Chromium uses after measured export."""
    tmp_path = _write_json_temp(options)
    try:
        probe = subprocess.run(
            ["node", str(_BRIDGE), "build-report", tmp_path],
            cwd=str(_SCRIPTS_DIR),
            capture_output=True,
            text=True,
            check=False,
        )
        return _parse_bridge_stdout(probe)
    finally:
        Path(tmp_path).unlink(missing_ok=True)


def assert_measured_results_export_report(report):
    """Reject incomplete measured export reports."""
    tmp_path = _write_json_temp(report)
    try:
        probe = subprocess.run(
            ["node", str(_BRIDGE), "assert-report", tmp_path],
            cwd=str(_SCRIPTS_DIR),
            capture_output=True,
            text=True,
            check=False,
        )
        return _parse_bridge_stdout(probe)
    finally:
        Path(tmp_path).unlink(missing_ok=True)
