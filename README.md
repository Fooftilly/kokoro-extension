# Kokoro TTS Extension

A browser extension (Chrome & Firefox) that integrates **Kokoro TTS** to provide high-quality text-to-speech functionality for web content. It supports two modes: reading highlighted text or reading whole article.

## Features

- **High-Quality TTS**: Powered by Kokoro-FastAPI (requires local server).
- **Cross-Browser Support**: Works on both Google Chrome and Mozilla Firefox.
- **Smart Text Normalization**:
  - Expands contractions (e.g., "don't" -> "do not").
  - Transliterates non-Latin scripts (e.g., Japanese, Chinese, Greek, Cyrillic...) to Latin characters for better pronunciation.
  - Handles dates, fractions, measurements, and other some other special cases intelligently.
- **Playback Controls**: Speed control, play/pause/stop.
- **Streaming Audio**: Low-latency audio streaming.

## Prerequisites

- **Node.js** and **npm** installed for building the extension.
- **Kokoro-FastAPI**: You need a running instance of the Kokoro TTS server (e.g., running locally via Docker) for the extension to generate audio. See more at [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI).

## Installation & Build

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/Fooftilly/kokoro-extension.git
    cd kokoro-extension
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Build the extension:**
    ```bash
    node build.js
    ```
    This will create a `dist/` directory containing two subdirectories:
    - `dist/chrome`: Unpacked extension for Google Chrome.
    - `dist/firefox`: Unpacked extension for Mozilla Firefox.

## Loading the Extension

### Google Chrome
1.  Open Chrome and navigate to `chrome://extensions/`.
2.  Enable **Developer mode** in the top right corner.
3.  Click **Load unpacked**.
4.  Select the `dist/chrome` directory.

### Mozilla Firefox
1.  Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2.  Click **Load Temporary Add-on...**.
3.  Navigate to the `dist/firefox` directory and select the `manifest.json` file.

## Usage

1.  **Start the Local Server**: Ensure your Kokoro-FastAPI server is running at `http://127.0.0.1:8880` (API endpoint: `/v1/audio/speech`).
2.  **Generate TTS for Highlighted Text**: Highlight any text on a webpage. Right click and select "Send to Kokoro TTS".
3.  **Generate TTS for Whole Article**: Right click on any page and select "Read Article with Kokoro TTS".

## Credits

- **Kokoro TTS** through [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI)
- **Libraries used**:
  - [Compromise](https://github.com/spencermountain/compromise) for text normalization.
  - [Transliteration](https://github.com/yf-hk/transliteration) for script conversion.
  - [WebExtension Polyfill](https://github.com/mozilla/webextension-polyfill) for cross-browser compatibility.
  - [Readability](https://github.com/mozilla/readability) for parsing article content.
