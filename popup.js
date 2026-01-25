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

// --- Voice Mixer Logic ---
let currentVoices = [];
let availableVoices = [];
let voiceFetchError = false;

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
 * Fetches available voices from the API.
 */
async function fetchVoices(apiUrl) {
    try {
        const response = await fetch(`${apiUrl}audio/voices`);
        if (!response.ok) throw new Error('Failed to fetch voices');
        const data = await response.json();
        voiceFetchError = false;
        // Filter for specific prefixes as requested
        const validPrefixes = ['am_', 'af_', 'bm_', 'bf_'];
        return data.voices.filter(v => validPrefixes.some(prefix => v.startsWith(prefix)));
    } catch (e) {
        console.error("Error fetching voices:", e);
        voiceFetchError = true;
        return [];
    }
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
const saveOptions = async (isDebounced = false) => {
    if (isDebounced) {
        clearTimeout(saveTimeout);
        saveTimeout = setTimeout(() => saveOptions(false), 500);
        return;
    }

    const apiUrl = document.getElementById('apiUrl').value;
    const voice = serializeVoiceString(currentVoices);
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const defaultSpeed = document.getElementById('defaultSpeed').value;
    const defaultVolume = document.getElementById('defaultVolume').value;
    const autoScroll = document.getElementById('autoScroll').checked;
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
    const settings = { apiUrl, voice, mode, defaultSpeed, defaultVolume, autoScroll, showFloatingButton, normalizationOptions, theme };

    try {
        // 1. Save settings immediately so they are persisted even if permission is pending
        await browser.storage.sync.set(settings);
        await browser.storage.local.set({ defaultSpeed, defaultVolume, autoScroll, showFloatingButton, normalizationOptions, theme });

        // 2. Check permissions for custom URL
        if (!isLocalhost(apiUrl)) {
            try {
                const urlObj = new URL(apiUrl);
                const origin = urlObj.origin + "/*";
                const hasPerm = await browser.permissions.contains({ origins: [origin] });
                if (!hasPerm) {
                    const granted = await browser.permissions.request({ origins: [origin] });
                    if (!granted) {
                        const status = document.getElementById('status');
                        status.textContent = "Permission denied for this URL.";
                        status.style.color = "var(--status-error)";
                        status.style.display = 'block';
                        setTimeout(() => {
                            status.style.display = 'none';
                            status.style.color = "var(--status-success)";
                        }, 3000);
                        return;
                    }
                }
            } catch (e) {
                // Invalid URL - ignore for now as it's already saved anyway
            }
        }

        // Show generic saving toast
        const status = document.getElementById('status');
        status.textContent = "Settings saved.";
        status.style.color = "var(--status-success)";
        status.style.display = 'block';
        setTimeout(() => { status.style.display = 'none'; }, 1500);
    } catch (e) {
        console.error("Error saving options", e);
        const status = document.getElementById('status');
        status.textContent = "Error: " + e.message;
        status.style.color = "var(--status-error)";
        status.style.display = 'block';
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

        // Fetch available voices for the dropdown
        fetchVoices(items.apiUrl).then(voices => {
            availableVoices = voices;
        });

        if (items.mode === 'stream') {
            document.getElementById('modeStream').checked = true;
        } else {
            document.getElementById('modeDownload').checked = true;
        }
        document.getElementById('defaultSpeed').value = items.defaultSpeed;
        document.getElementById('defaultVolume').value = items.defaultVolume;
        document.getElementById('autoScroll').checked = items.autoScroll;
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

searchInput.addEventListener('input', () => {
    const query = searchInput.value.toLowerCase();
    const filtered = availableVoices.filter(v => v.toLowerCase().includes(query) && !currentVoices.some(cv => cv.id === v));

    dropdown.innerHTML = '';

    if (query.length > 0) {
        if (voiceFetchError) {
            dropdown.style.display = 'block';
            dropdown.innerHTML = '<div class="note" style="color: var(--status-error); padding: 8px;">Error: Could not reach API to fetch voices.</div>';
        } else if (filtered.length > 0) {
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
    } else {
        dropdown.style.display = 'none';
    }
});

// Hide dropdown when clicking outside
document.addEventListener('click', (e) => {
    if (e.target !== searchInput && e.target !== dropdown) {
        dropdown.style.display = 'none';
    }
});

document.addEventListener('DOMContentLoaded', () => {
    restoreOptions();

    // Setup Autosave Listeners
    const inputs = document.querySelectorAll('input, select');
    inputs.forEach(input => {
        if (input.id === 'voiceSearch' || input.id === 'apiUrl') return;

        const eventType = (input.type === 'text' || input.type === 'number') ? 'input' : 'change';
        input.addEventListener(eventType, () => {
            saveOptions(input.type === 'text');
        });
    });

    // Manual API URL Save
    const saveApiBtn = document.getElementById('saveApiUrl');
    saveApiBtn.addEventListener('click', async () => {
        const url = document.getElementById('apiUrl').value;
        await saveOptions(false);
        checkApiConnection(url);
    });
});

async function checkApiConnection(url) {
    const statusEl = document.getElementById('apiStatus');
    statusEl.style.display = 'block';
    statusEl.textContent = 'Checking connection...';
    statusEl.className = 'note mt-2';

    try {
        // Ensure url ends with /
        const baseUrl = url.endsWith('/') ? url : url + '/';
        const response = await fetch(`${baseUrl}test`, {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        });

        if (!response.ok) throw new Error('Network response was not ok');
        const data = await response.json();

        if (data.status === 'ok') {
            statusEl.textContent = 'Connected successfully!';
            statusEl.classList.add('api-status-success');
            setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
        } else {
            throw new Error('Invalid status message');
        }
    } catch (e) {
        console.error("API Connectivity Check failed:", e);
        statusEl.textContent = 'Unable to connect to API. Please check the URL and ensure the server is running.';
        statusEl.classList.add('api-status-error');
    }
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

