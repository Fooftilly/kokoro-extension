"""Firefox dual measured-results export — load shared ESM asserts via Node."""
from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent


def _run_measured_export_node(script: str, data=None):
    """Run a static Node script; optional JSON payload arrives via argv file.

    Sonar flags interpolating download/file JSON into ``node -e`` as command
    injection; keep the ``-e`` source static and pass data through a tempfile.
    """
    tmp_path = None
    argv = ["node", "--input-type=module", "-e", script]
    if data is not None:
        with tempfile.NamedTemporaryFile(
                "w", suffix=".json", delete=False, encoding="utf-8") as handle:
            json.dump(data, handle)
            tmp_path = handle.name
        argv.append(tmp_path)
    try:
        probe = subprocess.run(
            argv,
            cwd=str(_SCRIPTS_DIR),
            capture_output=True,
            text=True,
            check=False,
        )
    finally:
        if tmp_path:
            Path(tmp_path).unlink(missing_ok=True)
    if probe.returncode != 0:
        raise RuntimeError(
            "Measured export Node helper failed: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return json.loads(probe.stdout.strip() or "null")


def measured_export_constants():
    """Constants shared with Chromium measured-export acceptance."""
    return _run_measured_export_node(
        "import {"
        "MEASURED_EXPORT_KIND as kind,"
        "MEASURED_EXPORT_FILENAME as filename,"
        "MEASURED_EXPORT_BUTTON_ID as buttonId,"
        "MEASURED_EXPORT_STATUS_NEEDLE as statusNeedle,"
        "} from './measured-results-export-acceptance.mjs';"
        "console.log(JSON.stringify({"
        "kind,filename,buttonId,statusNeedle}));"
    )


def assert_measured_results_export_payload(payload, expected=None):
    """Assert local-only measured export payload shape."""
    expected = expected or {}
    return _run_measured_export_node(
        "import { readFileSync } from 'node:fs';"
        "import { assertMeasuredResultsExportPayload } from "
        "'./measured-results-export-acceptance.mjs';"
        "const data=JSON.parse(readFileSync(process.argv[1],'utf8'));"
        "assertMeasuredResultsExportPayload(data.payload, data.expected);"
        "console.log(JSON.stringify({ok:true}));",
        {"payload": payload, "expected": expected},
    )


def build_measured_results_export_report(**options):
    """Build the same report shape Chromium uses after measured export."""
    return _run_measured_export_node(
        "import { readFileSync } from 'node:fs';"
        "import { buildMeasuredResultsExportReport } from "
        "'./measured-results-export-acceptance.mjs';"
        "const options=JSON.parse(readFileSync(process.argv[1],'utf8'));"
        "console.log(JSON.stringify("
        "buildMeasuredResultsExportReport(options)));",
        options,
    )


def assert_measured_results_export_report(report):
    """Reject incomplete measured export reports."""
    return _run_measured_export_node(
        "import { readFileSync } from 'node:fs';"
        "import { assertMeasuredResultsExportReport } from "
        "'./measured-results-export-acceptance.mjs';"
        "const report=JSON.parse(readFileSync(process.argv[1],'utf8'));"
        "assertMeasuredResultsExportReport(report);"
        "console.log(JSON.stringify({ok:true}));",
        report,
    )
