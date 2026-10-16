# Speech-to-text provider evaluation (Part B)

Sangam needs Tamil, Telugu, Hindi, and English recognition that behaves the same
in every browser. This note compares the realistic options and records the
choice behind the server adapter in `server/src/speech/`.

> Pricing below is approximate and was last checked in October 2026; verify
> current rates before committing budget. Figures are USD unless stated.

## Why the browser's Web Speech API is not enough

`SpeechRecognition` (Web Speech API) is convenient but not a portable product
foundation:

| Problem                    | Detail                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Vendor-hosted, opaque      | Chrome/Edge send audio to Google's service; results and language coverage are not under our control. |
| Browser-dependent coverage | Indic locales are inconsistent; Chrome's recognizer often falls back to English for `ta`/`te`.       |
| Brave blocks it            | Brave disables the speech service, so the API fails with `network` / `service-not-allowed`.          |
| Firefox                    | No usable `SpeechRecognition` implementation.                                                        |
| No server control          | No way to log, retry, dedupe, or bill recognition, and no path to translation/playback reuse.        |
| Privacy                    | Audio leaves through the browser to a third party we cannot contract with.                           |

The Web Speech API stays as an honest, clearly-labelled fallback (see the room
banner), not as the primary pipeline.

## Options compared

| Provider                    | Tamil      | Telugu     | Hindi | English | Streaming           | Interim | Explicit language         | Latency                                 | Price (approx)                       | Notes                                                                                                   |
| --------------------------- | ---------- | ---------- | ----- | ------- | ------------------- | ------- | ------------------------- | --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Deepgram Nova-3**         | ✅         | ✅         | ✅    | ✅      | ✅ WebSocket        | ✅      | ✅ per-session `language` | Very low (sub-second partials)          | ~$0.0048–0.0077/min (~$0.29–0.46/hr) | Nova-3 monolingual added Tamil/Telugu in 2026; simple token auth; strong streaming focus.               |
| Google Cloud STT v2 (Chirp) | ✅         | ✅         | ✅    | ✅      | ✅ gRPC/WS          | ✅      | ✅                        | Low                                     | ~$0.016/min (~$0.96/hr)              | Mature, but gRPC/proto client, GCP IAM, higher cost and heavier integration.                            |
| Azure Speech                | ✅         | ✅         | ✅    | ✅      | ✅                  | ✅      | ✅                        | Low                                     | ~$1/hr standard                      | Rich features (diarization, custom speech); heavier SDK and regional resource setup.                    |
| AssemblyAI                  | async ✅   | async ✅   | ✅    | ✅      | ⚠️ realtime limited | ✅      | ✅                        | Low                                     | ~$0.15/hr streaming                  | Excellent async; realtime language set is narrower — Tamil/Telugu streaming coverage is not guaranteed. |
| AWS Transcribe              | ⚠️         | ⚠️         | ✅    | ✅      | ✅                  | ✅      | ✅                        | Low–medium                              | ~$0.024/min                          | Streaming language list historically narrower for Indic languages; IAM + SigV4 signing overhead.        |
| OpenAI Whisper / Realtime   | ✅ (batch) | ✅ (batch) | ✅    | ✅      | ❌ batch only       | ❌      | ✅ batch                  | n/a live                                | ~$0.006/min batch                    | Great accuracy but not a streaming API for live rooms; Realtime API is English-first.                   |
| Groq Whisper large-v3-turbo | ✅         | ✅         | ✅    | ✅      | ❌ batch            | ❌      | ✅                        | Very low per chunk, but not incremental | cheap/fast                           | Chunked batch only; forces a record-then-transcribe UX, not live interims.                              |
| Self-hosted (Whisper/NeMo)  | ✅         | ✅         | ✅    | ✅      | partial             | partial | ✅                        | depends on GPU                          | infra cost                           | Best privacy/control, but real GPU ops and MLOps burden — out of scope for now.                         |

Legend: ✅ supported · ⚠️ partial/uncertain · ❌ not supported.

## Recommendation — Deepgram (Nova-3), via a server-side proxy

Deepgram is the best fit for a two-person live room:

1. **Language fit** — Nova-3 monolingual streams Tamil, Telugu, Hindi, and
   English today, with interim results.
2. **Streaming-first** — a single WebSocket per speaking turn, low-latency
   partials that drive the existing interim UI, and a documented close-to-flush
   path for the final segment.
3. **Simple auth** — an API key sent as a WebSocket subprotocol; no request
   signing, no IAM, no SDK. Easy to proxy.
4. **Cost** — roughly $0.005/min streaming is an order of magnitude cheaper than
   Google v2 at ~$0.016/min, which matters for long, chatty rooms.
5. **Privacy posture we can state honestly** — audio goes browser → our server →
   Deepgram. The key never reaches the browser, and the provider is swappable.

### Runner-up and when to switch

- **Google Cloud STT v2** if the deployment already lives in GCP and wants a
  single vendor with enterprise SLAs.
- **Self-hosted Whisper/Nemotron** if data must never leave our infrastructure;
  the provider interface exists precisely to make that swap a one-file change.

## How it is wired (and what is not proven)

- `SpeechProvider` (interface) → `mock` / `deepgram` / `none` implementations.
- `SPEECH_PROVIDER` selects `auto | deepgram | mock | none`; `auto` uses
  Deepgram only when `DEEPGRAM_API_KEY` is present.
- Browser audio (`getUserMedia` + `MediaRecorder`) streams over the existing
  Socket.IO connection (`speech:start` / `speech:audio` / `speech:stop`); the
  server relays interim lines and writes finals into the normal room transcript.

**Unverified:** no `DEEPGRAM_API_KEY` was available, so the Deepgram adapter is
covered only by a fake-socket unit test. The request URL, subprotocol auth, and
response parsing follow Deepgram's documented protocol but have **not** been
exercised against the live service with a real microphone. Until then, treat
live Deepgram recognition as incomplete, and use `SPEECH_PROVIDER=mock` for
demos or leave the default (`auto`, with no key → browser fallback).

## Required configuration to finish the integration

| Variable                      | Where   | Purpose                                                       |
| ----------------------------- | ------- | ------------------------------------------------------------- |
| `SPEECH_PROVIDER`             | server  | `deepgram` to require it, `auto` to opt in when a key exists. |
| `DEEPGRAM_API_KEY`            | server  | Secret. Never exposed to the browser.                         |
| `DEEPGRAM_MODEL`              | server  | Optional; defaults to `nova-3`.                               |
| `SPEECH_MAX_SESSION_BYTES`    | server  | Optional per-turn audio ceiling (default 12 MB).              |
| `NEXT_PUBLIC_SPEECH_PROVIDER` | browser | `auto` (default), `server`, or `browser`.                     |

### Remaining work before claiming production speech

1. Set a real `DEEPGRAM_API_KEY` and verify Tamil/Telugu/Hindi/English against a
   live microphone in Chrome, Brave, and Firefox.
2. Confirm Deepgram's streaming container support for the browser's chosen
   `MediaRecorder` codec (Opus/WebM) — or add a transcoding step.
3. Add server-side rate limiting/quotas per room and per IP.
4. Decide the retention policy for audio (currently never persisted; only
   transcripts are kept in memory).
