# Privacy Policy for Kokoro TTS Sender

**Last Updated:** December 7, 2025

## Introduction
Kokoro TTS Sender ("we," "our," or "the extension") is a browser extension designed to convert text from web pages into speech using a self-hosted Kokoro TTS server. We do not collect, store, or transmit any of your personal data to any third-party servers. This Privacy Policy explains what the extension does with your data.

## Data Collection
The extension does not collect, store, or transmit any of your personal data to any third-party servers. The extension operates by sending the text you select (or the content of the article you are viewing) directly to a **local server running on your own machine** that you configure and control (e.g., `http://127.0.0.1:8880`). 

## Data Usage
- **Text Processing:** The text content you select is sent solely to the API endpoint you configure (defaulting to localhost) for the purpose of generating audio.
- **Settings:** User preferences (such as API URL, voice selection, and playback speed) are stored locally in your browser's sync storage to persist your settings across sessions.

## Third-Party Sharing
We do not share any data with third parties. The extension relies on a local connection to your own instance of the Kokoro TTS API. It does not communicate with any external cloud services or analytics platforms.

## Permisions
The extension requests the following permissions to function:
- **Read and change all your data on the websites you visit:** Required to extract article text for the "Read Article" feature and to display the playback overlay on the page.
- **Notifications:** Used to provide status updates (e.g., "Generating audio...") and error messages.
- **Downloads:** Used to save the generated audio files to your computer if you select "Download File" output mode.

## Changes to This Policy
We may update this Privacy Policy from time to time. Any changes will be posted on this page.

## Contact
If you have questions about this Privacy Policy, please contact me by opening an issue on the extension's GitHub repository.
