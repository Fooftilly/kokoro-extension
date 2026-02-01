const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');

const EXTENSION_NAME = 'Kokoro TTS Sender';
const EXTENSION_VERSION = '1.3.0';
const DESCRIPTION = 'Send text from browser to Kokoro-FastAPI for TTS generation';

const SRC_FILES = [
    'background.js',
    'content.js',
    'overlay.css',
    'overlay.html',
    'overlay.js',
    'popup.css',
    'popup.html',
    'popup.js',
    'text-processor.js',
    'audio-manager.js',
    'dom-utils.js',
    'transliteration-lite.js',
    'theme-init.js',
    'reader.html',
    'reader.js',
    'reader.css'
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

const TRANSLITERATION_SRC = 'transliteration-lite.js';
const TRANSLITERATION_DEST = 'transliteration-lite.js';

const DOMPURIFY_SRC = 'node_modules/dompurify/dist/purify.js';
const DOMPURIFY_DEST = 'purify.js';

const EPUBJS_SRC = 'node_modules/epubjs/dist/epub.min.js';
const EPUBJS_DEST = 'epub.min.js';

const JSZIP_SRC = 'node_modules/jszip/dist/jszip.min.js';
const JSZIP_DEST = 'jszip.min.js';



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
            "notifications",
            "scripting",
            "alarms"
            // "downloads" is added conditionally below if needed, or kept common
        ],
        host_permissions: [
            "http://127.0.0.1/*",
            "http://localhost/*"
        ],
        optional_host_permissions: [
            "*://*/*"
        ],
        action: {
            default_popup: "popup.html",
            default_icon: {
                "48": "icons/icon48.png",
                "128": "icons/icon128.png"
            }
        },
        icons: {
            "48": "icons/icon48.png",
            "128": "icons/icon128.png"
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
                resources: ["overlay.html", "overlay.css", "overlay.js", "text-processor.js", "audio-manager.js", "dom-utils.js", "browser-polyfill.min.js",
                    "compromise.js", "compromise-dates.min.js", "compromise-numbers.min.js",
                    "transliteration-lite.js", "purify.js", "theme-init.js",
                    "reader.html", "reader.js", "reader.css",
                    "epub.min.js", "jszip.min.js"],
                matches: ["<all_urls>"]
            }
        ],
        commands: {
            "read-article": {
                "suggested_key": {
                    "default": "Alt+A"
                },
                "description": "Read Article with Kokoro TTS"
            },
            "nav-next": {
                "suggested_key": {
                    "default": "Alt+Period"
                },
                "description": "Next Sentence"
            },
            "nav-prev": {
                "suggested_key": {
                    "default": "Alt+Comma"
                },
                "description": "Previous Sentence"
            },
            "close-overlay": {
                "suggested_key": {
                    "default": "Alt+W"
                },
                "description": "Close Overlay"
            }
        }
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
                strict_min_version: "142.0" // Bumped to 142 for data_collection_permissions support (Android too)
            }
        };
        // Add data_collection_permissions as required by Firefox
        // Error "must NOT have fewer than 1 items".
        // Docs: "Must contain the value none, or one or more of..."
        // So we use ["none"].
        commonManifest.browser_specific_settings.gecko.data_collection_permissions = {
            required: ["none"]
        };
    }

    return JSON.stringify(commonManifest, null, 2);
}

function build() {
    console.log('Running tests...');
    try {
        execSync('npm test', { stdio: 'inherit' });
    } catch (e) {
        console.error('Tests failed. Build aborted.');
        process.exit(1);
    }

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

        // Copy dompurify
        copyFile(path.join(__dirname, DOMPURIFY_SRC), path.join(browserDist, DOMPURIFY_DEST));

        // Copy epubjs & jszip
        copyFile(path.join(__dirname, EPUBJS_SRC), path.join(browserDist, EPUBJS_DEST));
        copyFile(path.join(__dirname, JSZIP_SRC), path.join(browserDist, JSZIP_DEST));


        // Generate Manifest
        const manifest = createManifest(browser);
        fs.writeFileSync(path.join(browserDist, 'manifest.json'), manifest);

        console.log(`Built ${browser} extension in dist/${browser}`);
    });
    // Check for --package flag
    if (process.argv.includes('--package')) {
        console.log('Packaging extensions...');
        const packageDir = path.join(distDir, 'package');
        if (!fs.existsSync(packageDir)) {
            fs.mkdirSync(packageDir);
        }
        packageChrome(path.join(distDir, 'chrome'), packageDir);
        packageFirefox(path.join(distDir, 'firefox'), packageDir);
    }
    if (process.argv.includes('--source')) {
        console.log('Creating source package...');
        packageSource(__dirname);
    }
}

function packageChrome(sourceDir, outputDir) {
    try {
        const zipName = `kokoro-extension-chrome-${EXTENSION_VERSION}.zip`;
        const outputPath = path.join(outputDir, zipName);

        // Remove existing zip if any
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }

        console.log(`Creating Chrome package: ${zipName}`);

        const zip = new AdmZip();
        // Add local folder to the zip
        zip.addLocalFolder(sourceDir);
        // Write the zip to disk
        zip.writeZip(outputPath);

        console.log(`Chrome package created at ${outputPath}`);
    } catch (error) {
        console.error('Error packaging for Chrome:', error.message);
    }
}

function packageFirefox(sourceDir, outputDir) {
    try {
        console.log('Creating Firefox package using web-ext...');
        const zipName = `kokoro-extension-firefox-${EXTENSION_VERSION}.zip`;
        // web-ext build --source-dir ... --artifacts-dir ...
        // We use npx to run it without adding it as a permanent dependency if not wanted,
        // though adding it to devDependencies is good practice. Use npx -y to auto-confirm.

        // --filename is relative to artifacts-dir
        execSync(`npx -y web-ext build --source-dir "${sourceDir}" --artifacts-dir "${outputDir}" --filename "${zipName}" --overwrite-dest`);
        console.log(`Firefox package created: ${path.join(outputDir, zipName)}`);
    } catch (error) {
        console.error('Error packaging for Firefox:', error.message);
    }
}

function packageSource(rootDir) {
    try {
        const zipName = 'kokoro-extension-source.zip';
        // Change output directory to dist/source-zip
        const distDir = path.join(rootDir, 'dist');
        const outputDir = path.join(distDir, 'source-zip');

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const outputPath = path.join(outputDir, zipName);

        // Remove existing zip if any
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }

        console.log(`Creating source package: ${zipName}`);

        const zip = new AdmZip();

        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const entry of entries) {
            const entryName = entry.name;
            const fullPath = path.join(rootDir, entryName);

            // Exclude ignored folders and files
            // Also exclude the zip itself if it was in root (though we moved it now)
            if (['node_modules', 'dist', '.git', '.gitignore', zipName].includes(entryName)) {
                continue;
            }

            if (entry.isDirectory()) {
                zip.addLocalFolder(fullPath, entryName);
            } else {
                zip.addLocalFile(fullPath);
            }
        }

        zip.writeZip(outputPath);
        console.log(`Source package created at ${outputPath}`);
    } catch (error) {
        console.error('Error packaging source:', error.message);
    }
}

build();
