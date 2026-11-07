// Extension-origin preflight: intentionally no network or model fetch.
const runCheck = document.getElementById('runCheck');
const copyCheck = document.getElementById('copyCheck');
const output = document.getElementById('report');
const statusEl = document.getElementById('status');
let report = null;

runCheck.addEventListener('click', async () => {
    runCheck.disabled = true;
    copyCheck.disabled = true;
    statusEl.textContent = 'Checking WASM and GPU adapter availability...';
    try {
        report = await window.KokoroBenchmark.inspectCapabilities();
        output.textContent = JSON.stringify(report, null, 2);
        statusEl.textContent = 'Browser preflight complete. No model was loaded.';
        copyCheck.disabled = false;
    } catch (error) {
        report = null;
        output.textContent = '';
        statusEl.textContent = 'Preflight failed: ' + String(error.message || error);
    } finally {
        runCheck.disabled = false;
    }
});

copyCheck.addEventListener('click', async () => {
    if (!report) return;
    try {
        await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
        statusEl.textContent = 'Local report copied. No data was uploaded.';
    } catch (error) {
        statusEl.textContent = 'Clipboard unavailable; select the report text to copy.';
    }
});
