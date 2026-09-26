// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.content').forEach(c => c.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(tab.dataset.tab).classList.add('active');
    });
});

// Save/Load Logic
// Helper to check if URL is localhost
const isLocalhost = (url) => {
    try {
        const u = new URL(url);
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch {
        return false;
    }
};

/** Normalize API URL the same way Save does (protocol + trailing slash). */
function normalizeApiUrl(raw) {
    let apiUrl = (raw || '').trim();
    if (apiUrl) {
        if (!/^https?:\/\//i.test(apiUrl)) {
            apiUrl = `http://${apiUrl}`;
        }
        if (!apiUrl.endsWith('/')) {
            apiUrl += '/';
        }
    }
    return apiUrl;
}

/**
 * Optional host-permission origin pattern for a non-local API URL.
 * @returns {{ origin: string|null, invalidUrl: boolean }}
 */
function hostPermissionOriginInfo(apiUrl) {
    if (!apiUrl || isLocalhost(apiUrl)) {
        return { origin: null, invalidUrl: false };
    }
    try {
        return { origin: `${new URL(apiUrl).origin}/*`, invalidUrl: false };
    } catch {
        return { origin: null, invalidUrl: true };
    }
}

/**
 * Start permissions.request() synchronously (Firefox user-gesture).
 * Call from click handlers before any await. Do not await contains() first.
 * @returns {Promise<boolean>|null}
 */
function beginHostPermissionRequest(apiUrl) {
    const { origin, invalidUrl } = hostPermissionOriginInfo(apiUrl);
    if (invalidUrl || !origin) {
        return null;
    }
    return browser.permissions.request({ origins: [origin] });
}

function applyPermissionDeniedUI() {
    availableVoices = [];
    voiceFetchStatus = {
        kind: 'permission',
        message: messageForKind('permission'),
    };
    setApiStatusUI('permission', messageForKind('permission'), {
        showRetry: true,
    });
}

// --- Voice Mixer Logic ---
let currentVoices = [];
let availableVoices = [];
/** @type {{ kind: string, message: string }} */
let voiceFetchStatus = { kind: 'idle', message: '' };
/** @type {{ kind: string, message: string }} */
let connectionStatus = { kind: 'idle', message: '' };
/** Monotonic token so only the latest refresh applies UI/voice results. */
let refreshGeneration = 0;
/** @type {AbortController|null} */
let activeRefreshAbort = null;

function setApiStatusUI(kind, message, { showRetry = true } = {}) {
    const row = document.getElementById('apiStatusRow');
    const statusEl = document.getElementById('apiStatus');
    const retryBtn = document.getElementById('retryApi');
    if (!row || !statusEl) return;

    connectionStatus = { kind, message };

    if (kind === 'idle') {
        statusEl.textContent = message || '';
        statusEl.className = 'note mt-2';
        // Neutral idle can keep Retry visible (e.g. URL edited mid-probe).
        if (showRetry) {
            row.style.display = 'flex';
            if (retryBtn) retryBtn.style.display = 'inline-block';
        } else {
            row.style.display = 'none';
            if (retryBtn) retryBtn.style.display = 'none';
        }
        return;
    }

    row.style.display = 'flex';
    statusEl.textContent = message;
    statusEl.className = 'note mt-2';
    if (kind === 'ok') {
        statusEl.classList.add('api-status-success');
    } else if (kind === 'checking') {
        statusEl.classList.add('api-status-checking');
    } else {
        statusEl.classList.add('api-status-error');
    }

    if (retryBtn) {
        const hideRetry = kind === 'ok' || kind === 'checking' || !showRetry;
        retryBtn.style.display = hideRetry ? 'none' : 'inline-block';
    }
}

/**
 * Probe connection and refresh voice list. Settings UI always remains usable.
 * Newer calls abort/supersede in-flight work so stale URLs cannot overwrite status.
 *
 * @param {object} [options]
 * @param {Promise<boolean>|null} [options.permissionRequestPromise]
 *   Pending result of permissions.request() started synchronously in a click
 *   handler (Save/Retry). When omitted, only permissions.contains() is used
 *   (reopen / probe without user gesture). Never call request() here after awaits.
 */
async function refreshBackendStatus(apiUrl, {
    hideOkAfterMs = 0,
    timeoutMs,
    permissionRequestPromise = null,
} = {}) {
    const generation = ++refreshGeneration;
    const requestedUrl = apiUrl;

    if (activeRefreshAbort) {
        try {
            activeRefreshAbort.abort();
        } catch (_) {
            /* ignore */
        }
    }
    const controller = new AbortController();
    activeRefreshAbort = controller;

    setApiStatusUI('checking', messageForKind('checking'), { showRetry: false });

    const isLatestGeneration = () => generation === refreshGeneration;
    const urlMatchesRequest = () => {
        const el = document.getElementById('apiUrl');
        return !!el && el.value === requestedUrl;
    };

    /**
     * @returns {boolean} true if caller should discard results and return
     * - Superseded generation: discard silently (newer refresh owns UI)
     * - Latest gen but URL edited without Save/Retry: clear stuck Checking, show Retry
     */
    const shouldDiscardResults = () => {
        if (!isLatestGeneration()) {
            return true;
        }
        if (!urlMatchesRequest()) {
            setApiStatusUI('idle', '', { showRetry: true });
            return true;
        }
        return false;
    };

    try {
        // Non-local hosts need optional host permission — do not mislabel as unreachable.
        const { origin, invalidUrl } = hostPermissionOriginInfo(requestedUrl);
        if (invalidUrl) {
            // Malformed URL — let the probe surface the error (not a permission issue).
        } else if (origin) {
            let hasPerm = false;
            if (permissionRequestPromise) {
                try {
                    hasPerm = await permissionRequestPromise;
                } catch (_) {
                    // Rejected request (e.g. lost user gesture) → permission state.
                    hasPerm = false;
                }
            } else {
                try {
                    hasPerm = await browser.permissions.contains({ origins: [origin] });
                } catch (_) {
                    // Permission API failure — not a URL parse error; skip probe.
                    hasPerm = false;
                }
            }
            if (shouldDiscardResults()) return;
            if (!hasPerm) {
                applyPermissionDeniedUI();
                return;
            }
        }

        const requestOpts = { signal: controller.signal, timeoutMs };
        const probe = await probeApiConnection(requestedUrl, fetch, requestOpts);
        if (shouldDiscardResults() || probe.aborted) return;

        const voicesResult = await fetchNormalizedVoices(requestedUrl, fetch, requestOpts);
        if (shouldDiscardResults()) return;

        const resolved = resolveBackendStatus(probe, voicesResult);
        availableVoices = resolved.voices;
        voiceFetchStatus = {
            kind: voicesResult.kind,
            message: voicesResult.message || '',
        };
        setApiStatusUI(resolved.kind, resolved.message, { showRetry: resolved.showRetry });

        if (resolved.kind === 'ok' && hideOkAfterMs > 0) {
            setTimeout(() => {
                if (generation === refreshGeneration && connectionStatus.kind === 'ok') {
                    setApiStatusUI('idle', '', { showRetry: false });
                }
            }, hideOkAfterMs);
        }
    } catch (e) {
        if (shouldDiscardResults() || (e && e.name === 'AbortError')) {
            return;
        }
        console.error('Backend status refresh failed:', e);
        const kind = classifyApiFailure(e);
        availableVoices = [];
        voiceFetchStatus = { kind, message: messageForKind(kind, 'API') };
        setApiStatusUI(kind, voiceFetchStatus.message);
    } finally {
        if (generation === refreshGeneration && activeRefreshAbort === controller) {
            activeRefreshAbort = null;
        }
    }
}

/**
 * Parses a voice string into an array of voice objects.
 * Format: "voice1(weight1)+voice2(weight2)"
 */
function parseVoiceString(str) {
    if (!str) return [];

    // Check if it's a simple single voice without weight
    if (!str.includes('+') && !str.includes('(')) {
        return [{ id: str.trim(), weight: 1.0 }];
    }

    const parts = str.split('+');
    return parts.map(part => {
        const match = part.match(/([^(]+)\(([^)]+)\)/);
        if (match) {
            let weight = parseFloat(match[2]);
            // Legacy conversion: if weight is > 1 (e.g. 5), treat it as 0.5
            if (weight > 1) {
                weight = weight / 10;
            }
            return {
                id: match[1].trim(),
                weight: weight
            };
        } else {
            return { id: part.trim(), weight: 1.0 };
        }
    }).filter(v => v.id);
}

/**
 * Serializes an array of voice objects into a string.
 */
function serializeVoiceString(voices) {
    if (!voices || voices.length === 0) return '';
    // If only one voice, send it without weight to avoid API errors
    if (voices.length === 1) return voices[0].id;
    // Always use the format voice(weight) for consistency based on user request/screenshot
    return voices.map(v => `${v.id}(${v.weight})`).join('+');
}

/**
 * Renders the voice mixer UI.
 */
function renderVoiceMixer() {
    const container = document.getElementById('selectedVoices');
    container.innerHTML = '';

    if (currentVoices.length === 0) {
        container.innerHTML = '<div class="note">No voices selected. Search above to add.</div>';
        return;
    }

    // Create the main bar
    const bar = document.createElement('div');
    bar.className = 'voice-mixer-bar';
    container.appendChild(bar);

    // Create a voice list for removal (optional, but good for UX)
    const list = document.createElement('div');
    list.className = 'voice-list mt-10';
    container.appendChild(list);

    const colors = ['#007bff', '#28a745', '#fd7e14', '#6f42c1', '#e83e8c', '#20c997', '#ffc107', '#17a2b8'];

    // Normalize weights to sum to 1.0 if they don't
    const totalWeight = currentVoices.reduce((sum, v) => sum + v.weight, 0);
    if (totalWeight > 0 && Math.abs(totalWeight - 1.0) > 0.001) {
        currentVoices.forEach(v => v.weight = v.weight / totalWeight);
    } else if (totalWeight === 0) {
        currentVoices.forEach(v => v.weight = 1.0 / currentVoices.length);
    }

    let cumulativePercent = 0;

    currentVoices.forEach((voice, index) => {
        const percent = voice.weight * 100;
        const segment = document.createElement('div');
        segment.className = 'voice-segment';
        segment.style.width = `${percent}%`;
        segment.style.backgroundColor = colors[index % colors.length];

        const label = document.createElement('div');
        label.className = 'voice-segment-label';
        label.textContent = voice.id;
        segment.appendChild(label);

        const percentLabel = document.createElement('div');
        percentLabel.className = 'voice-segment-percent';
        percentLabel.textContent = `${Math.round(percent)}%`;
        segment.appendChild(percentLabel);

        // Click to edit
        segment.addEventListener('click', (e) => {
            if (e.target.tagName === 'INPUT') return;
            showEditInput(segment, index);
        });

        bar.appendChild(segment);

        // Add handle if not the last segment
        if (index < currentVoices.length - 1) {
            cumulativePercent += percent;
            const handle = document.createElement('div');
            handle.className = 'voice-handle';
            handle.style.left = `${cumulativePercent}%`;

            handle.addEventListener('mousedown', (e) => {
                e.preventDefault();
                startDragging(index, handle, bar);
            });

            bar.appendChild(handle);
        }

        // Add to list for removal
        const row = document.createElement('div');
        row.className = 'voice-row';
        row.style.borderLeft = `4px solid ${colors[index % colors.length]}`;

        row.innerHTML = `
            <span class="voice-name">${voice.id}</span>
            <div class="voice-row-actions">
                <input type="number" class="voice-row-weight" value="${Math.round(percent)}" min="1" max="99">%
                <span class="remove-voice" title="Remove voice">&times;</span>
            </div>
        `;

        const rowInput = row.querySelector('.voice-row-weight');
        rowInput.addEventListener('change', (e) => {
            const newVal = parseInt(e.target.value);
            if (!isNaN(newVal) && newVal >= 1 && newVal <= 99) {
                updateVoiceWeight(index, newVal / 100);
            } else {
                renderVoiceMixer();
            }
        });

        row.querySelector('.remove-voice').addEventListener('click', () => {
            currentVoices.splice(index, 1);
            if (currentVoices.length > 0) {
                // Redistribute weight
                const remaining = 1.0 / currentVoices.length;
                currentVoices.forEach(v => v.weight = remaining);
            }
            renderVoiceMixer();
            saveOptions();
        });
        list.appendChild(row);
    });
}

function showEditInput(segment, index) {
    const label = segment.querySelector('.voice-segment-label');
    const oldText = label.textContent;
    const currentVal = Math.round(currentVoices[index].weight * 100);

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'voice-edit-input';
    input.value = currentVal;
    input.min = 1;
    input.max = 99;

    label.innerHTML = '';
    label.appendChild(input);
    input.focus();
    input.select();

    const finishEdit = () => {
        const newVal = parseInt(input.value);
        if (!isNaN(newVal) && newVal >= 1 && newVal <= 99) {
            updateVoiceWeight(index, newVal / 100);
        } else {
            renderVoiceMixer();
        }
    };

    input.addEventListener('blur', finishEdit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finishEdit();
        if (e.key === 'Escape') renderVoiceMixer();
    });
}

function updateVoiceWeight(index, newWeight) {
    const oldWeight = currentVoices[index].weight;
    const delta = newWeight - oldWeight;

    // Constraints
    const MIN_WEIGHT = 0.05;
    if (newWeight < MIN_WEIGHT) newWeight = MIN_WEIGHT;
    if (newWeight > 1.0 - (currentVoices.length - 1) * MIN_WEIGHT) {
        newWeight = 1.0 - (currentVoices.length - 1) * MIN_WEIGHT;
    }

    currentVoices[index].weight = newWeight;

    // Redistribute delta to others
    const others = currentVoices.filter((_, i) => i !== index);
    if (others.length > 0) {
        // Try to take from right first, then left (as requested)
        // For simplicity here, we distribute proportionally to others
        const actualDelta = newWeight - oldWeight;
        const othersTotal = others.reduce((sum, v) => sum + v.weight, 0);

        others.forEach(v => {
            v.weight -= (actualDelta * (v.weight / othersTotal));
            if (v.weight < MIN_WEIGHT) v.weight = MIN_WEIGHT;
        });

        // Final normalization to ensure sum is 1.0
        const finalTotal = currentVoices.reduce((sum, v) => sum + v.weight, 0);
        currentVoices.forEach(v => v.weight /= finalTotal);
    }

    renderVoiceMixer();
    saveOptions();
}

function startDragging(index, handle, bar) {
    const barRect = bar.getBoundingClientRect();
    const MIN_WIDTH_PERCENT = 5;

    const onMouseMove = (e) => {
        let mouseX = e.clientX - barRect.left;
        let percent = (mouseX / barRect.width) * 100;

        // Calculate limits based on adjacent segments
        let prevCumulative = 0;
        for (let i = 0; i < index; i++) {
            prevCumulative += currentVoices[i].weight * 100;
        }

        let nextWeight = currentVoices[index + 1].weight * 100;
        let currentWeight = currentVoices[index].weight * 100;

        // Handle position must be between (prevCumulative + min) and (prevCumulative + current + next - min)
        const minPos = prevCumulative + MIN_WIDTH_PERCENT;
        const maxPos = prevCumulative + currentWeight + nextWeight - MIN_WIDTH_PERCENT;

        if (percent < minPos) percent = minPos;
        if (percent > maxPos) percent = maxPos;

        // Update weights of index and index + 1
        const newCurrentWeight = (percent - prevCumulative);
        const newNextWeight = (currentWeight + nextWeight) - newCurrentWeight;

        currentVoices[index].weight = newCurrentWeight / 100;
        currentVoices[index + 1].weight = newNextWeight / 100;

        renderVoiceMixer();
    };

    const onMouseUp = () => {
        saveOptions(); // Autosave only on release
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
}


let saveTimeout;
/**
 * Persist settings. Does not call permissions.request() — Firefox requires that
 * to start synchronously in a user-gesture handler. Pass permissionRequestPromise
 * from Save click when a host-permission request was started there.
 *
 * @param {boolean} [isDebounced]
 * @param {{ permissionRequestPromise?: Promise<boolean>|null }} [options]
 */
const saveOptions = async (isDebounced = false, options = {}) => {
    if (isDebounced) {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => saveOptions(false), 500);
        return { ok: true, deferred: true };
    }

    const permissionRequestPromise = options.permissionRequestPromise || null;
    const apiUrl = normalizeApiUrl(document.getElementById('apiUrl').value);
    document.getElementById('apiUrl').value = apiUrl;
    const voice = serializeVoiceString(currentVoices);
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const defaultSpeed = document.getElementById('defaultSpeed').value;
    const defaultVolume = document.getElementById('defaultVolume').value;
    const autoScroll = document.getElementById('autoScroll').checked;
    const autoplayReader = document.getElementById('autoplayReader').checked;
    const showFloatingButton = document.getElementById('showFloatingButton').checked;

    const normalizationOptions = {
        normalize: document.getElementById('norm_normalize').checked,
        unit_normalization: document.getElementById('norm_unit').checked,
        url_normalization: document.getElementById('norm_url').checked,
        email_normalization: document.getElementById('norm_email').checked,
        optional_pluralization_normalization: document.getElementById('norm_plural').checked,
        phone_normalization: document.getElementById('norm_phone').checked,
        replace_remaining_symbols: document.getElementById('norm_symbol').checked
    };

    const theme = document.documentElement.classList.contains('dark-theme') ? 'dark' : 'light';
    const settings = { apiUrl, voice, mode, defaultSpeed, defaultVolume, autoScroll, autoplayReader, showFloatingButton, normalizationOptions, theme };

    const showPermissionDeniedToast = () => {
        const status = document.getElementById('status');
        status.textContent = 'Permission denied for this URL.';
        status.style.color = 'var(--status-error)';
        status.style.display = 'block';
        applyPermissionDeniedUI();
        setTimeout(() => {
            status.style.display = 'none';
            status.style.color = 'var(--status-success)';
        }, 3000);
    };

    try {
        // 1. Persist immediately even if permission is pending/denied
        await browser.storage.sync.set(settings);
        await browser.storage.local.set({ defaultSpeed, defaultVolume, autoScroll, autoplayReader, showFloatingButton, normalizationOptions, theme });

        // 2. Host permission for non-local URL (never call request() here after awaits)
        const { origin, invalidUrl } = hostPermissionOriginInfo(apiUrl);
        if (!invalidUrl && origin) {
            let hasPerm = false;
            if (permissionRequestPromise) {
                try {
                    hasPerm = await permissionRequestPromise;
                } catch (_) {
                    hasPerm = false;
                }
            } else {
                try {
                    hasPerm = await browser.permissions.contains({ origins: [origin] });
                } catch (_) {
                    hasPerm = false;
                }
            }
            if (!hasPerm) {
                showPermissionDeniedToast();
                return { ok: false, permissionDenied: true };
            }
        }

        // Show generic saving toast
        const status = document.getElementById('status');
        status.textContent = "Settings saved.";
        status.style.color = "var(--status-success)";
        status.style.display = 'block';
        setTimeout(() => { status.style.display = 'none'; }, 1500);
        return { ok: true, permissionDenied: false };
    } catch (e) {
        console.error("Error saving options", e);
        const status = document.getElementById('status');
        status.textContent = "Error: " + e.message;
        status.style.color = "var(--status-error)";
        status.style.display = 'block';
        return { ok: false, error: true };
    }
};

const restoreOptions = async () => {
    try {
        const items = await browser.storage.sync.get({
            apiUrl: 'http://127.0.0.1:8880/v1/',
            voice: 'af_sarah(0.5)+af_nicole(0.3)+af_sky(0.2)',
            mode: 'stream',
            defaultSpeed: '1.0',
            defaultVolume: '1.0',
            autoScroll: false,
            autoplayReader: false,
            showFloatingButton: true,
            normalizationOptions: {
                normalize: true,
                unit_normalization: false,
                url_normalization: true,
                email_normalization: true,
                optional_pluralization_normalization: true,
                phone_normalization: true,
                replace_remaining_symbols: true
            },
            theme: 'light'
        });

        if (items.theme === 'dark') {
            document.documentElement.classList.add('dark-theme');
            localStorage.setItem('kokoro-theme', 'dark');
        } else {
            document.documentElement.classList.remove('dark-theme');
            localStorage.setItem('kokoro-theme', 'light');
        }

        document.getElementById('apiUrl').value = items.apiUrl;

        currentVoices = parseVoiceString(items.voice);
        renderVoiceMixer();

        // Probe connection + voices on open (no aggressive polling).
        // Settings above are already rendered from storage — backend loss cannot blank the UI.
        refreshBackendStatus(items.apiUrl);

        if (items.mode === 'stream') {
            document.getElementById('modeStream').checked = true;
        } else {
            document.getElementById('modeDownload').checked = true;
        }
        document.getElementById('defaultSpeed').value = items.defaultSpeed;
        document.getElementById('defaultVolume').value = items.defaultVolume;
        document.getElementById('autoScroll').checked = items.autoScroll;
        document.getElementById('autoplayReader').checked = items.autoplayReader;
        document.getElementById('showFloatingButton').checked = items.showFloatingButton;

        const norm = items.normalizationOptions;
        document.getElementById('norm_normalize').checked = norm.normalize;
        document.getElementById('norm_unit').checked = norm.unit_normalization;
        document.getElementById('norm_url').checked = norm.url_normalization;
        document.getElementById('norm_email').checked = norm.email_normalization;
        document.getElementById('norm_plural').checked = norm.optional_pluralization_normalization;
        document.getElementById('norm_phone').checked = norm.phone_normalization;
        document.getElementById('norm_symbol').checked = norm.replace_remaining_symbols;

    } catch (e) {
        console.error("Error restoring options", e);
    }
};

// Search Dropdown Logic
const searchInput = document.getElementById('voiceSearch');
const dropdown = document.getElementById('voiceDropdown');

const updateVoiceDropdown = () => {
    const query = searchInput.value.toLowerCase();
    const filtered = availableVoices.filter(v => v.toLowerCase().includes(query) && !currentVoices.some(cv => cv.id === v));

    dropdown.innerHTML = '';

    const fetchFailed = voiceFetchStatus.kind === 'network'
        || voiceFetchStatus.kind === 'http'
        || voiceFetchStatus.kind === 'malformed';

    if (fetchFailed && (query.length > 0 || filtered.length === 0)) {
        dropdown.style.display = 'block';
        const note = document.createElement('div');
        note.className = 'note';
        note.style.color = 'var(--status-error)';
        note.style.padding = '8px';
        note.textContent = voiceFetchStatus.message
            || messageForKind(voiceFetchStatus.kind, 'Voice list');
        dropdown.appendChild(note);
        return;
    }

    if (voiceFetchStatus.kind === 'empty' && filtered.length === 0 && (query.length > 0 || availableVoices.length === 0)) {
        dropdown.style.display = 'block';
        const note = document.createElement('div');
        note.className = 'note';
        note.style.padding = '8px';
        note.textContent = voiceFetchStatus.message || messageForKind('empty');
        dropdown.appendChild(note);
        return;
    }

    if (filtered.length > 0) {
        dropdown.style.display = 'block';
        filtered.forEach(voice => {
            const div = document.createElement('div');
            div.className = 'voice-option';
            div.textContent = voice;
            div.addEventListener('click', () => {
                if (currentVoices.length === 0) {
                    currentVoices.push({ id: voice, weight: 1.0 });
                } else {
                    // Split the last segment
                    const lastVoice = currentVoices[currentVoices.length - 1];
                    const half = lastVoice.weight / 2;
                    lastVoice.weight = half;
                    currentVoices.push({ id: voice, weight: half });
                }
                renderVoiceMixer();
                saveOptions();
                searchInput.value = '';
                dropdown.style.display = 'none';
            });
            dropdown.appendChild(div);
        });
    } else {
        dropdown.style.display = 'none';
    }
};

searchInput.addEventListener('input', updateVoiceDropdown);
searchInput.addEventListener('focus', updateVoiceDropdown);
searchInput.addEventListener('click', updateVoiceDropdown);

// Hide dropdown when clicking outside
document.addEventListener('click', (e) => {
    if (e.target !== searchInput && e.target !== dropdown) {
        dropdown.style.display = 'none';
    }
});

document.addEventListener('DOMContentLoaded', () => {
    restoreOptions();

    // Display version
    try {
        const manifest = browser.runtime.getManifest();
        document.getElementById('version').textContent = `v${manifest.version}`;
    } catch (e) {
        console.error("Error getting manifest version:", e);
    }

    // Setup Autosave Listeners
    const inputs = document.querySelectorAll('input, select');
    inputs.forEach(input => {
        if (input.id === 'voiceSearch' || input.id === 'apiUrl') return;

        const eventType = (input.type === 'text' || input.type === 'number') ? 'input' : 'change';
        input.addEventListener(eventType, () => {
            saveOptions(input.type === 'text');
        });
    });

    // Manual API URL Save — start host-permission request synchronously (Firefox
    // user-gesture), then persist + re-probe. Skip probe if permission denied.
    const saveApiBtn = document.getElementById('saveApiUrl');
    saveApiBtn.addEventListener('click', async () => {
        const url = normalizeApiUrl(document.getElementById('apiUrl').value);
        document.getElementById('apiUrl').value = url;
        // Must call permissions.request before any await (Firefox user-action).
        const permissionRequestPromise = beginHostPermissionRequest(url);
        const saveResult = await saveOptions(false, { permissionRequestPromise });
        if (saveResult && saveResult.permissionDenied) {
            return;
        }
        await refreshBackendStatus(url, {
            hideOkAfterMs: 3000,
            permissionRequestPromise,
        });
    });

    const retryApiBtn = document.getElementById('retryApi');
    if (retryApiBtn) {
        retryApiBtn.addEventListener('click', async () => {
            const url = normalizeApiUrl(document.getElementById('apiUrl').value);
            document.getElementById('apiUrl').value = url;
            // User gesture: start request synchronously before any await.
            const permissionRequestPromise = beginHostPermissionRequest(url);
            await refreshBackendStatus(url, {
                hideOkAfterMs: 3000,
                permissionRequestPromise,
            });
        });
    }

    // Open Document Handler
    const openDocBtn = document.getElementById('openDocumentBtn');
    if (openDocBtn) {
        openDocBtn.addEventListener('click', () => {
            browser.tabs.create({ url: 'reader.html' });
        });
    }
});

async function checkApiConnection(url) {
    await refreshBackendStatus(url, { hideOkAfterMs: 3000 });
}

// Theme Toggle
document.getElementById('theme-toggle').addEventListener('click', () => {
    document.documentElement.classList.toggle('dark-theme');
    // Save theme immediately
    const isDark = document.documentElement.classList.contains('dark-theme');
    const theme = isDark ? 'dark' : 'light';
    localStorage.setItem('kokoro-theme', theme);
    browser.storage.sync.set({ theme });
    browser.storage.local.set({ theme });
});

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        refreshBackendStatus,
        saveOptions,
        setApiStatusUI,
        normalizeApiUrl,
        beginHostPermissionRequest,
        getConnectionStatus: () => connectionStatus,
        getAvailableVoices: () => availableVoices,
        getVoiceFetchStatus: () => voiceFetchStatus,
    };
}

