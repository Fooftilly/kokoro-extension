// Early theme detection to prevent flicker
(function () {
    const applyTheme = (theme) => {
        if (theme === 'dark') {
            document.documentElement.classList.add('dark-theme');
        } else {
            document.documentElement.classList.remove('dark-theme');
        }
    };

    // 1. Immediate sync from localStorage (fastest, current session only)
    const savedTheme = localStorage.getItem('kokoro-theme') || 'light';
    applyTheme(savedTheme);

    // 2. Sync from extension storage (cross-page sync)
    // We try 'browser' first (polyfill), then 'chrome' (native)
    const api = (typeof browser !== 'undefined') ? browser : (typeof chrome !== 'undefined' ? chrome : null);

    if (api && api.storage) {
        const storageArea = api.storage.local;

        // Initial fetch from storage
        const getTheme = () => {
            // storage.local.get can take a string or object in both namespaces
            if (typeof browser !== 'undefined') {
                storageArea.get('theme').then(data => {
                    if (data && data.theme) applyTheme(data.theme);
                });
            } else {
                storageArea.get('theme', (data) => {
                    if (data && data.theme) applyTheme(data.theme);
                });
            }
        };
        getTheme();

        // Listen for storage changes in real-time
        api.storage.onChanged.addListener((changes, areaName) => {
            // Area name might be 'local' or 'sync' depending on implementation
            if (changes.theme) {
                applyTheme(changes.theme.newValue);
            }
        });
    }
})();
