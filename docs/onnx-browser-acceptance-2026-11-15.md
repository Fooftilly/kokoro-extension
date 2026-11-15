# ONNX q8 browser acceptance, 15 November 2026

Follow-up to #52, #53 and #60 after merging #178 and #179.

## Reproduction and provenance

Both manually dispatched runs target application commit
`b1d27eec947c3ecc26409dc609c848a20fe3ef39` and use the repository's
`Real Kokoro MV3 model acceptance` workflow:

```sh
gh workflow run live-browser-acceptance.yml --ref master \
  -f acceptance_scope=chromium-onnx-origin
gh workflow run live-browser-acceptance.yml --ref master \
  -f acceptance_scope=firefox-onnx-origin
```

`master` moves; compare each run's `head_sha` with the commit above when
reproducing. The workflow builds Chrome and Firefox packages from source.
Executable ONNX Runtime Web JS/WASM is packaged locally; these scopes use
the model manager's real Download control for pinned model/voice data.

- Official ONNX Runtime Web: `onnxruntime-web@1.31.1`.
- Model repository revision: `1939ad2a8e416c0acfeecc08a694d14ef25f2231`.
- q8 model plus fixed voice: 92,885,404 bytes.
- Separately opted-in CMUdict: 3,618,488 bytes at revision
  `74790861f652b15e4ac49015a90074ad62a27690`.
- Combined model, voice and dictionary data: 96,503,892 bytes, excluding
  the executable runtime and packaged tokenizer/configuration data.

## Browser reports

Both workflows **passed** on the commit above. The committed
[machine-readable summary](validation/2026-11-15-onnx-browser-acceptance.json)
contains selected fields from the final reports; the linked workflow artifacts
retain the full reports.

| Browser / Linux runner | Workflow | Full report artifact |
| --- | --- | --- |
| Chromium 158.0.0.0 | [43742716947](https://github.com/Fooftilly/kokoro-extension/actions/runs/43742716947) | [14172828730](https://github.com/Fooftilly/kokoro-extension/actions/runs/43742716947/artifacts/14172828730), `report.json` |
| Firefox 160.0 | [43742720163](https://github.com/Fooftilly/kokoro-extension/actions/runs/43742720163) | [14173655259](https://github.com/Fooftilly/kokoro-extension/actions/runs/43742720163/artifacts/14173655259), `firefox.json` |

Both reports demonstrate:

- Model/voice Download UI size matching 92,885,404 transferred and cached
  bytes, 100% progress, full pinned SHA-256 and verified dictionary data.
- Offline, finite, non-silent 24-kHz ONNX PCM and ordinary English routed
  through `AudioManager` to local WAV; unknown English words fail closed.
- Overlay Next/Previous, speed/volume, play/pause and Retry after an actual
  unsupported-word failure. These automated controls are not a listening test.
- A real EPUB selected through the file input: three chapters and a nested
  section (four spine items), distinct audio per item, then replacement with
  `acceptance.txt`. Autoplay stays disabled and the backend preference survives.
- Floating-mic selection and native X11 Alt+A article dispatch, distinct WAVs,
  and extraction containing both fixture paragraphs. This checks the article
  entry path and first audio; it does not prove listening to a whole article.
- A 36-sentence overlay fixture, 17 walk positions plus return/distant-jump
  probes, at most **five cache entries and five Blob URLs**, and distinct
  audio after the jump. No server fallback or user-backend preference change.

The Chromium JS-heap delta was -103,112,645 bytes, within the harness's
268,435,456-byte growth bound. This two-snapshot delta includes garbage
collection; it is not peak memory or a claim that the engine used less memory.
Firefox reported `heap: null`; no Firefox heap measurement is claimed.

Chromium also passed a real browser-process restart with cached model status
and dictionary SHA-256 retained, simulated eviction and explicit dictionary
repair. Firefox's ordinary origin scope tested extension-page reload, **not**
a permanent add-on/browser-process restart. Both passed dictionary
Download/Cancel/Retry/Remove UI checks. Firefox additionally cancelled the
ONNX voice download and retried only the missing voice while retaining the
verified model; its offline model removal retained the dictionary/other caches.

## Observed benchmark timings

These are the **first shared-English UI benchmark** results for `Hello world.`
(1.875 seconds of generated audio). The separate IPA diagnostic timings are
not mixed into this table. Cold prep means initialization plus the first
untimed synthesis; warm columns follow that preparation and contain three
completed full-clip syntheses. p95 is the nearest-rank statistic of those three
runs, not a population latency estimate.

| Browser | Cold prep (ms) | Warm p50 (ms) | Warm p95 (ms) | RTF p50 |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 3785 | 2270 | 2275 | 1.21 |
| Firefox | 2682 | 1418 | 1473 | 0.76 |

The browsers ran on separate hosted runners; these observations cannot rank
browser performance on the same device. They measure full generation, not
streaming time to first audio. The benchmark UI also passed clear-on-edit,
IPA-only exclusion, explicit backend selection and restored-result checks.

## Interpretation

These scopes exercise dictionary-supported English fixtures. A 36-sentence
fixture and bounded cache navigation do not establish arbitrary-article
pronunciation quality, continuous multi-minute audio quality or total native
WASM memory usage. The article test loads a local HTTP fixture while online,
then switches offline before selection/article synthesis.

Neither scope accepts GPU inference, other ONNX precisions, additional
voices, unrestricted/OOV G2P, multilingual parity, Windows/device coverage,
progressive streaming time to first audio, or store signing/distribution.
The separate permanent Firefox add-on/browser-restart and real-quota scopes
are not substitutes for, or implied by, these origin-download runs.

Keep #52, #53 and #60 open for their remaining acceptance criteria.
