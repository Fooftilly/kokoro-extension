# Privacy Policy for Kokoro TTS Sender

**Last Updated:** September 26, 2026

## Introduction

Kokoro TTS Sender ("we," "our," or "the extension") is a browser extension that converts text from web pages into speech using a **Kokoro-FastAPI** server that **you** configure and control. This Privacy Policy explains what the extension does with data.

## Data collection

The extension does not collect personal data for advertising or analytics, and it does not include telemetry that phones home to the extension author.

Speech generation works by sending the text you select (or article content extracted for “Read Article”) to the **API base URL you configure** in settings. The default is a local address (`http://127.0.0.1:8880/v1/`), but you may point the extension at a LAN or remote Kokoro-FastAPI endpoint. In those cases, text is transmitted over the network to that endpoint. If you configure a remote (or other non-local) **`http://`** URL rather than **`https://`**, that text is sent **unencrypted in transit** (cleartext HTTP). Prefer HTTPS for any endpoint that leaves a trusted local network.

## Data usage

- **Text processing:** Selected or extracted text is sent only to your configured Kokoro-FastAPI endpoint to generate audio.
- **Settings:** Preferences (API URL, voice selection, playback options, normalization toggles, theme, etc.) are stored primarily in the browser’s **`storage.sync`** API (with some values also mirrored in `storage.local`). When browser sync is enabled for your account, the browser provider (e.g. Chrome/Firefox) may synchronize those settings across your signed-in devices according to that provider’s policies. The extension author does not operate a separate settings sync service.

## Third-party sharing

The extension does not share data with third parties for analytics or advertising. It communicates with:

- The web pages you use it on (to extract text and show the overlay), and
- The Kokoro-FastAPI endpoint you configure.

If that endpoint is operated by someone else, their privacy policy applies to data they receive.

## Permissions

The extension requests permissions needed to function, including:

- **Access to website content** — extract article/selection text and display the playback overlay.
- **Notifications** — status and error messages.
- **Downloads** — save generated audio when “Download” mode is selected.
- **Host access** — default localhost permissions; optional broader host permission when you configure a non-local API URL.

## Changes to this policy

We may update this Privacy Policy from time to time. Any changes will be posted on this page.

## Contact

If you have questions about this Privacy Policy, open an issue on the extension’s GitHub repository. For security vulnerabilities, see [`SECURITY.md`](./SECURITY.md) and use private reporting when available.
