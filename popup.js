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
        // Filter for specific prefixes as requested
        const validPrefixes = ['am_', 'af_', 'bm_', 'bf_'];
        return data.voices.filter(v => validPrefixes.some(prefix => v.startsWith(prefix)));
    } catch (e) {
        console.error("Error fetching voices:", e);
        return [];
    }
}

/**
 * Renders the voice mixer UI.
 */
function renderVoiceMixer() {
    const container = document.getElementById('selectedVoices');
    container.innerHTML = '';

    currentVoices.forEach((voice, index) => {
        const row = document.createElement('div');
        row.className = 'voice-row';

        const nameSpan = document.createElement('span');
        nameSpan.className = 'voice-name';
        nameSpan.textContent = voice.id;

        const weightContainer = document.createElement('div');
        weightContainer.className = 'voice-weight-container';

        const weightInput = document.createElement('input');
        weightInput.type = 'number';
        weightInput.className = 'voice-weight';
        weightInput.value = voice.weight;
        weightInput.step = '0.1';
        weightInput.min = '0';
        weightInput.max = '10'; // Allow values > 1 if user wants, though usually <=1
        weightInput.addEventListener('change', (e) => {
            currentVoices[index].weight = parseFloat(e.target.value) || 0;
        });

        const removeBtn = document.createElement('span');
        removeBtn.className = 'remove-voice';
        removeBtn.innerHTML = '&times;';
        removeBtn.title = 'Remove voice';
        removeBtn.addEventListener('click', () => {
            currentVoices.splice(index, 1);
            renderVoiceMixer();
        });

        weightContainer.appendChild(weightInput);
        weightContainer.appendChild(removeBtn);

        row.appendChild(nameSpan);
        row.appendChild(weightContainer);
        container.appendChild(row);
    });
}


const saveOptions = async () => {
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

    try {
        // Check permissions for custom URL
        if (!isLocalhost(apiUrl)) {
            const urlObj = new URL(apiUrl);
            // We request permission for the specific origin
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
                        status.style.color = "var(--status-success)"; // Reset color
                        status.textContent = "Settings saved."; // Reset text
                    }, 3000);
                    return; // Abort save
                }
            }
        }

        await browser.storage.sync.set({ apiUrl, voice, mode, defaultSpeed, defaultVolume, autoScroll, showFloatingButton, normalizationOptions, theme });
        // Also update local storage for the overlay to pick up immediately if needed
        await browser.storage.local.set({ defaultSpeed, defaultVolume, autoScroll, showFloatingButton, normalizationOptions, theme });

        const status = document.getElementById('status');
        status.textContent = "Settings saved.";
        status.style.color = "var(--status-success)";
        status.style.display = 'block';
        setTimeout(() => { status.style.display = 'none'; }, 2000);
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
    if (filtered.length > 0 && query.length > 0) {
        dropdown.style.display = 'block';
        filtered.forEach(voice => {
            const div = document.createElement('div');
            div.className = 'voice-option';
            div.textContent = voice;
            div.addEventListener('click', () => {
                currentVoices.push({ id: voice, weight: 0.5 }); // Default weight
                renderVoiceMixer();
                searchInput.value = '';
                dropdown.style.display = 'none';
            });
            dropdown.appendChild(div);
        });
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

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);

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

