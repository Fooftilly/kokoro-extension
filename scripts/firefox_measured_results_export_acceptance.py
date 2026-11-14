"""Firefox dual measured-results export — load shared ESM asserts via Node."""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent


def measured_export_constants():
    """Constants shared with Chromium measured-export acceptance."""
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import {"
            "MEASURED_EXPORT_KIND as kind,"
            "MEASURED_EXPORT_FILENAME as filename,"
            "MEASURED_EXPORT_BUTTON_ID as buttonId,"
            "MEASURED_EXPORT_STATUS_NEEDLE as statusNeedle,"
            "} from './measured-results-export-acceptance.mjs';"
            "console.log(JSON.stringify({"
            "kind,filename,buttonId,statusNeedle}));",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "Cannot load measured export constants: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return json.loads(probe.stdout.strip())


def assert_measured_results_export_payload(payload, expected=None):
    """Assert local-only measured export payload shape."""
    expected = expected or {}
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { assertMeasuredResultsExportPayload } from "
            "'./measured-results-export-acceptance.mjs';"
            "assertMeasuredResultsExportPayload("
            + json.dumps(payload) + ", " + json.dumps(expected) + ");"
            "console.log(JSON.stringify({ok:true}));",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "Measured export payload assert failed: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return json.loads(probe.stdout.strip())


def build_measured_results_export_report(**options):
    """Build the same report shape Chromium uses after measured export."""
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { buildMeasuredResultsExportReport } from "
            "'./measured-results-export-acceptance.mjs';"
            "console.log(JSON.stringify(buildMeasuredResultsExportReport("
            + json.dumps(options) + ")));",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "Cannot build measured export report: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return json.loads(probe.stdout.strip())


def assert_measured_results_export_report(report):
    """Reject incomplete measured export reports."""
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { assertMeasuredResultsExportReport } from "
            "'./measured-results-export-acceptance.mjs';"
            "assertMeasuredResultsExportReport("
            + json.dumps(report) + ");"
            "console.log(JSON.stringify({ok:true}));",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "Measured export report assert failed: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return json.loads(probe.stdout.strip())
