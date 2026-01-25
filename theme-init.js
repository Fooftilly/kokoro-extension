// Early theme detection to prevent flicker
(function () {
    const theme = localStorage.getItem('kokoro-theme') || 'light';
    if (theme === 'dark') {
        document.documentElement.classList.add('dark-theme');
    }
    if (typeof browser !== 'undefined' && browser.storage) {
        browser.storage.local.get('theme').then(data => {
            if (data.theme === 'dark') {
                document.documentElement.classList.add('dark-theme');
            } else if (data.theme === 'light') {
                document.documentElement.classList.remove('dark-theme');
            }
        });
    }
})();
