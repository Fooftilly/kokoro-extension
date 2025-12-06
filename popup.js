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
const saveOptions = async () => {
    const apiUrl = document.getElementById('apiUrl').value;
    const voice = document.getElementById('voice').value;
    const mode = document.querySelector('input[name="mode"]:checked').value;
    const defaultSpeed = document.getElementById('defaultSpeed').value;
    const defaultVolume = document.getElementById('defaultVolume').value;

    try {
        await browser.storage.sync.set({ apiUrl, voice, mode, defaultSpeed, defaultVolume });
        // Also update local storage for the overlay to pick up immediately if needed
        await browser.storage.local.set({ defaultSpeed, defaultVolume });

        const status = document.getElementById('status');
        status.style.display = 'block';
        setTimeout(() => { status.style.display = 'none'; }, 2000);
    } catch (e) {
        console.error("Error saving options", e);
    }
};

const restoreOptions = async () => {
    try {
        const items = await browser.storage.sync.get({
            apiUrl: 'http://127.0.0.1:8880/v1/',
            voice: 'af_heart(10)+af_bella(7.5)+af_jessica(2.5)',
            mode: 'download',
            defaultSpeed: '1.0',
            defaultVolume: '1.0'
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
    } catch (e) {
        console.error("Error restoring options", e);
    }
};

document.addEventListener('DOMContentLoaded', restoreOptions);
document.getElementById('save').addEventListener('click', saveOptions);

