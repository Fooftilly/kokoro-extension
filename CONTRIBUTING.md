# Contributing

Thanks for helping improve **Kokoro TTS Sender**.

## Before you start

1. Search [existing issues](https://github.com/Fooftilly/kokoro-extension/issues) and pull requests.
2. Prefer a focused issue (bug, feature, or engineering task template) before a large PR.
3. Read [`AGENTS.md`](./AGENTS.md) for architecture, commands, and hard rules.

## Development setup

Requirements: **Node.js `^20.19.0 || ^22.13.0 || >=24`** (matches ESLint 10; CI uses Node 22) and npm.

```bash
git clone https://github.com/Fooftilly/kokoro-extension.git
cd kokoro-extension
npm ci
```

## Everyday commands

| Command | Purpose |
| --- | --- |
| `npm test` | Jest unit tests (Kokoro API mocked; no live server required) |
| `npm run lint` | ESLint on source and tests |
| `npm run build` | Run tests and emit `dist/chrome` + `dist/firefox` |
| `npm run package` | Build and create store zip packages |

Load unpacked builds from `dist/chrome` or `dist/firefox` as described in the README.

## Pull requests

- Keep PRs bounded to one deliverable.
- Do **not** edit generated `dist/` files; change sources and rebuild.
- Add or update Jest coverage for behavior changes.
- Before opening/updating a PR, run `npm ci`, `npm test`, `npm run lint`, and `npm run build`.
- Do not broaden extension permissions or add telemetry without an explicit, reviewed reason.
- Align `package.json` `version` only when intentionally cutting a release; manifests are generated from it.

## Security

Report vulnerabilities privately — see [`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the MIT License (see [`LICENSE`](./LICENSE)).
