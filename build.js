const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const EXTENSION_NAME = 'Kokoro TTS Sender';
const EXTENSION_VERSION = '1.0';
const DESCRIPTION = 'Send text from browser to Kokoro-FastAPI for TTS generation';

const SRC_FILES = [
    'background.js',
    'content.js',
    'overlay.css',
    'overlay.html',
    'overlay.js',
    'popup.html',
    'popup.js'
];

const ICONS_DIR = 'icons';

const POLYFILL_SRC = 'node_modules/webextension-polyfill/dist/browser-polyfill.min.js';
const POLYFILL_DEST = 'browser-polyfill.min.js';

const READABILITY_SRC = 'node_modules/@mozilla/readability/Readability.js';
const READABILITY_DEST = 'readability.js';

const COMPROMISE_SRC = 'node_modules/compromise/builds/compromise.js';
const COMPROMISE_DEST = 'compromise.js';
const COMPROMISE_DATES_SRC = 'node_modules/compromise-dates/builds/compromise-dates.min.js';
const COMPROMISE_DATES_DEST = 'compromise-dates.min.js';
const COMPROMISE_NUMBERS_SRC = 'node_modules/compromise-numbers/builds/compromise-numbers.min.js';
const COMPROMISE_NUMBERS_DEST = 'compromise-numbers.min.js';

const TRANSLITERATION_SRC = 'node_modules/transliteration/dist/browser/bundle.umd.min.js';
const TRANSLITERATION_DEST = 'transliteration.min.js';

function copyFile(src, dest) {
    fs.copyFileSync(src, dest);
}

function copyDir(src, dest) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            copyDir(srcPath, destPath);
        } else {
            copyFile(srcPath, destPath);
        }
    }
}

function createManifest(browser) {
    const commonManifest = {
        manifest_version: 3,
        name: EXTENSION_NAME,
        version: EXTENSION_VERSION,
        description: DESCRIPTION,
        permissions: [
            "contextMenus",
            "storage",
            "activeTab",
            "notifications"
            // "downloads" is added conditionally below if needed, or kept common
        ],
        host_permissions: [
            "http://127.0.0.1/*",
            "http://localhost/*"
        ],
        action: {
            default_popup: "popup.html",
            default_icon: {
                "48": "icons/icon48.png"
            }
        },
        icons: {
            "48": "icons/icon48.png"
        },
        content_scripts: [
            {
                matches: ["<all_urls>"],
                // Polyfill must be loaded before other scripts in content scripts context? 
                // Actually for content scripts, we inject it.
                js: [
                    "browser-polyfill.min.js",
                    "readability.js",
                    "content.js"
                ]
            }
        ],
        web_accessible_resources: [
            {
                resources: ["overlay.html", "overlay.js", "browser-polyfill.min.js", "compromise.js", "compromise-dates.min.js", "compromise-numbers.min.js", "transliteration.min.js"], // Added polyfill here too just in case
                matches: ["<all_urls>"]
            }
        ]
    };

    // Browser specific overrides
    if (browser === 'chrome') {
        commonManifest.permissions.push("downloads");
        commonManifest.background = {
            service_worker: "background.js"
        };
        // Chrome doesn't support browser_specific_settings usually
    } else if (browser === 'firefox') {
        commonManifest.permissions.push("downloads");
        commonManifest.background = {
            scripts: ["browser-polyfill.min.js", "background.js"]
        };
        commonManifest.browser_specific_settings = {
            gecko: {
                id: "{e4a64387-5c02-4809-a10c-982329d47225}",
                strict_min_version: "109.0"
            }
        };
    }

    return JSON.stringify(commonManifest, null, 2);
}

function build() {
    const distDir = path.resolve(__dirname, 'dist');
    if (fs.existsSync(distDir)) {
        fs.rmSync(distDir, { recursive: true, force: true });
    }
    fs.mkdirSync(distDir);

    const browsers = ['chrome', 'firefox'];

    browsers.forEach(browser => {
        const browserDist = path.join(distDir, browser);
        fs.mkdirSync(browserDist);

        // Copy source files
        SRC_FILES.forEach(file => {
            copyFile(path.join(__dirname, file), path.join(browserDist, file));
        });

        // Copy icons
        copyDir(path.join(__dirname, ICONS_DIR), path.join(browserDist, ICONS_DIR));

        // Copy polyfill
        copyFile(path.join(__dirname, POLYFILL_SRC), path.join(browserDist, POLYFILL_DEST));

        // Copy readability
        copyFile(path.join(__dirname, READABILITY_SRC), path.join(browserDist, READABILITY_DEST));

        // Copy compromise (nlp)
        copyFile(path.join(__dirname, COMPROMISE_SRC), path.join(browserDist, COMPROMISE_DEST));
        copyFile(path.join(__dirname, COMPROMISE_DATES_SRC), path.join(browserDist, COMPROMISE_DATES_DEST));
        copyFile(path.join(__dirname, COMPROMISE_NUMBERS_SRC), path.join(browserDist, COMPROMISE_NUMBERS_DEST));

        // Copy transliteration
        copyFile(path.join(__dirname, TRANSLITERATION_SRC), path.join(browserDist, TRANSLITERATION_DEST));

        // Generate Manifest
        const manifest = createManifest(browser);
        fs.writeFileSync(path.join(browserDist, 'manifest.json'), manifest);

        console.log(`Built ${browser} extension in dist/${browser}`);
    });
}

build();
