# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-09-26

Release-candidate packaging only — not published to Chrome Web Store or AMO yet.

### Reliability / API

- **New:** Clearer popup connection and voice-list error handling for Kokoro-FastAPI endpoints ([#4](https://github.com/Fooftilly/kokoro-extension/issues/4), [#22](https://github.com/Fooftilly/kokoro-extension/pull/22)).
- **Fixed:** Voice lists returned as objects (not plain strings) now normalize correctly in the popup mixer ([#6](https://github.com/Fooftilly/kokoro-extension/issues/6), [#22](https://github.com/Fooftilly/kokoro-extension/pull/22)).

### Text normalization

- **Fixed:** Possessive contractions such as `it's` / `that's` no longer lose the trailing `s` before TTS ([#7](https://github.com/Fooftilly/kokoro-extension/issues/7), [#23](https://github.com/Fooftilly/kokoro-extension/pull/23)).
- **Fixed:** Plural initialisms (for example `APIs`, `URLs`) keep a natural plural form instead of incorrect expansions ([#8](https://github.com/Fooftilly/kokoro-extension/issues/8), [#23](https://github.com/Fooftilly/kokoro-extension/pull/23)).

### Player UX

- **New:** Floating TTS player can be dragged within the viewport; position persists and is clamped on-screen ([#5](https://github.com/Fooftilly/kokoro-extension/issues/5), [#25](https://github.com/Fooftilly/kokoro-extension/pull/25)).
- **New:** Collapsible compact chrome (including full → floating) without stopping playback; **Close** still tears down the player and ends audio ([#5](https://github.com/Fooftilly/kokoro-extension/issues/5), [#25](https://github.com/Fooftilly/kokoro-extension/pull/25)).
- **Security-reliability:** Overlay `postMessage` handling hardened to the extension origin and iframe `event.source` ([#25](https://github.com/Fooftilly/kokoro-extension/pull/25)).

### Documentation

- **New:** README Stage 4 overlay docs and floating / dragged / collapsed showcase screenshots ([#26](https://github.com/Fooftilly/kokoro-extension/pull/26)).

### Compatibility

- Targets unchanged: Chrome and Firefox Manifest V3.
- Default host permissions remain `http://127.0.0.1/*` and `http://localhost/*`; optional `*://*/*` still requested at runtime for remote/LAN APIs.
- No telemetry added.

### Security / reliability notes

- No permission or host-permission broadening in this release.
- Extension-page CSP remains `script-src 'self'; object-src 'self'`.

## [1.3.1] - prior

Previous shipped store version (Chrome Web Store / AMO). See git history for earlier changes.
