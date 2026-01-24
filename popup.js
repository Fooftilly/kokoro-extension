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

const saveOptions = async () => {
    const apiUrl = document.getElementById('apiUrl').value;
    const voice = document.getElementById('voice').value;
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
                    status.style.color = "red";
                    status.style.display = 'block';
                    setTimeout(() => {
                        status.style.display = 'none';
                        status.style.color = "green"; // Reset color
                        status.textContent = "Settings saved."; // Reset text
                    }, 3000);
                    return; // Abort save
                }
            }
        }

        await browser.storage.sync.set({ apiUrl, voice, mode, defaultSpeed, defaultVolume, autoScroll, showFloatingButton, normalizationOptions });
        // Also update local storage for the overlay to pick up immediately if needed
        await browser.storage.local.set({ defaultSpeed, defaultVolume, autoScroll, showFloatingButton, normalizationOptions });

        const status = document.getElementById('status');
        status.textContent = "Settings saved.";
        status.style.color = "green";
        status.style.display = 'block';
        setTimeout(() => { status.style.display = 'none'; }, 2000);
    } catch (e) {
        console.error("Error saving options", e);
        const status = document.getElementById('status');
        status.textContent = "Error: " + e.message;
        status.style.color = "red";
        status.style.display = 'block';
    }
};

const restoreOptions = async () => {
    try {
        const items = await browser.storage.sync.get({
            apiUrl: 'http://127.0.0.1:8880/v1/',
            voice: 'af_sarah(5)+af_nicole(3)+af_sky(2)',
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
            }
        });

        document.getElementById('apiUrl').value = items.apiUrl;
        document.getElementById('voice').value = items.voice;
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

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);

