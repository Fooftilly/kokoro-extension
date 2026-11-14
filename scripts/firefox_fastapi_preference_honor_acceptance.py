"""Firefox FastAPI preference-honor — load shared ESM asserts via Node."""
import json
import subprocess
from pathlib import Path

_SCRIPTS_DIR = Path(__file__).resolve().parent


def preference_honor_speech():
    """Speech strings shared with Chromium preference-honor fixture."""
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { PREFERENCE_HONOR_SPEECH } from "
            "'./fastapi-preference-honor-acceptance.mjs';"
            "console.log(JSON.stringify(PREFERENCE_HONOR_SPEECH));",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "Cannot load PREFERENCE_HONOR_SPEECH: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return json.loads(probe.stdout.strip())


def preference_honor_fixture_html():
    """HTML fixture matching Chromium buildPreferenceHonorFixtureHtml."""
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { buildPreferenceHonorFixtureHtml } from "
            "'./fastapi-preference-honor-acceptance.mjs';"
            "process.stdout.write(buildPreferenceHonorFixtureHtml());",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0 or not probe.stdout:
        raise RuntimeError(
            "Cannot build preference-honor fixture HTML: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return probe.stdout


def build_fastapi_preference_honor_report(
        api_url, browser="Firefox", article_block_count=2,
        speech_stub_hits=None):
    """Build the same report shape Chromium uses after preference honor."""
    options = {
        "browser": browser,
        "apiUrl": api_url,
        "afterFastApiServerCard": True,
        "articleBlockCount": article_block_count,
        "speechStubHits": speech_stub_hits,
    }
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { buildFastApiPreferenceHonorReport } from "
            "'./fastapi-preference-honor-acceptance.mjs';"
            "console.log(JSON.stringify(buildFastApiPreferenceHonorReport("
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
            "Cannot build FastAPI preference-honor report: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return json.loads(probe.stdout.strip())


def assert_fastapi_preference_honor_report(report):
    """Fail closed if the report shape drifts from the shared ESM contract."""
    probe = subprocess.run(
        [
            "node", "--input-type=module", "-e",
            "import { assertFastApiPreferenceHonorReport } from "
            "'./fastapi-preference-honor-acceptance.mjs';"
            "assertFastApiPreferenceHonorReport(" + json.dumps(report) + ");"
            "console.log(JSON.stringify({ok:true}));",
        ],
        cwd=str(_SCRIPTS_DIR),
        capture_output=True,
        text=True,
        check=False,
    )
    if probe.returncode != 0:
        raise RuntimeError(
            "FastAPI preference-honor assert failed: " +
            (probe.stderr or probe.stdout or "unknown error"))
    return True
