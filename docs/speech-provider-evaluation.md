# Speech, translation, and playback provider evaluation (Part B)

Sangam needs Tamil, Telugu, Hindi, and English recognition — plus translation and
translated-speech playback — that behave the same in every browser. This note
compares the realistic options and records the choices behind the server
adapters in `server/src/speech/`, `server/src/translation/`, and
`server/src/tts/`.

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
banner), not as the primary pipeline. The browser's `speechSynthesis` is
likewise the last-resort *playback* path, after every server TTS provider.

## Options compared

| Provider                    | Tamil      | Telugu     | Hindi | English | Streaming           | Interim | Explicit language         | Latency                                 | Price (approx)                       | Notes                                                                                                   |
| --------------------------- | ---------- | ---------- | ----- | ------- | ------------------- | ------- | ------------------------- | --------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| **Sarvam Saaras**           | ✅         | ✅         | ✅    | ✅      | ⚠️ REST (per-turn)  | ❌      | ✅ per-request `language_code` | Low for short turns (~1 s)              | Indic-first pricing, flat per request | Purpose-built for Indic languages; one key across STT/translation/TTS; REST accepts WebM/Opus directly. |
| **Deepgram Nova-3**         | ✅         | ✅         | ✅    | ✅      | ✅ WebSocket        | ✅      | ✅ per-session `language` | Very low (sub-second partials)          | ~$0.0048–0.0077/min (~$0.29–0.46/hr) | Nova-3 monolingual added Tamil/Telugu in 2026; simple token auth; strong streaming focus.               |
| Google Cloud STT v2 (Chirp) | ✅         | ✅         | ✅    | ✅      | ✅ gRPC/WS          | ✅      | ✅                        | Low                                     | ~$0.016/min (~$0.96/hr)              | Mature, but gRPC/proto client, GCP IAM, higher cost and heavier integration.                            |
| Azure Speech                | ✅         | ✅         | ✅    | ✅      | ✅                  | ✅      | ✅                        | Low                                     | ~$1/hr standard                      | Rich features (diarization, custom speech); heavier SDK and regional resource setup.                    |
| AssemblyAI                  | async ✅   | async ✅   | ✅    | ✅      | ⚠️ realtime limited | ✅      | ✅                        | Low                                     | ~$0.15/hr streaming                  | Excellent async; realtime language set is narrower — Tamil/Telugu streaming coverage is not guaranteed. |
| AWS Transcribe              | ⚠️         | ⚠️         | ✅    | ✅      | ✅                  | ✅      | ✅                        | Low–medium                              | ~$0.024/min                          | Streaming language list historically narrower for Indic languages; IAM + SigV4 signing overhead.        |
| OpenAI Whisper / Realtime   | ✅ (batch) | ✅ (batch) | ✅    | ✅      | ❌ batch only       | ❌      | ✅ batch                  | n/a live                                | ~$0.006/min batch                    | Great accuracy but not a streaming API for live rooms; Realtime API is English-first.                   |
| Groq Whisper large-v3-turbo | ✅         | ✅         | ✅    | ✅      | ❌ batch            | ❌      | ✅                        | Very low per chunk, but not incremental | cheap/fast                           | Chunked batch only; forces a record-then-transcribe UX, not live interims.                              |
| Self-hosted (Whisper/NeMo)  | ✅         | ✅         | ✅    | ✅      | partial             | partial | ✅                        | depends on GPU                          | infra cost                           | Best privacy/control, but real GPU ops and MLOps burden — out of scope for now.                         |

Legend: ✅ supported · ⚠️ partial/uncertain · ❌ not supported.

## Recommendation — Sarvam (Saaras) first, Deepgram (Nova-3) as fallback

Sarvam is the best *default* for a two-person Indic-first live room:

1. **Indic-first accuracy** — Saaras targets Tamil, Telugu, Hindi, and the other
   supported Indic languages (plus English) directly, rather than treating them
   as an add-on to an English model.
2. **One credential, three legs** — the same `SARVAM_API_KEY` drives
   recognition (Saaras), translation (Mayura), and playback (Bulbul), which
   keeps configuration and billing to a single vendor.
3. **REST accepts the browser's own container** — the endpoint takes the
   `MediaRecorder` WebM/Opus blob directly (multipart), so no transcoding or
   raw-PCM plumbing is needed.
4. **Cost and simplicity** — no request signing, no SDK, no GCP IAM.

Deepgram stays configured as the recognition fallback so a Sarvam outage never
costs an utterance. Deepgram is *itself* the better fit when sub-second interim
partials matter, which is why the recognized chain keeps both.

### When to switch

- **Deepgram-first** when live interim latency is the priority (it is the one
  option here with true partials). Set `SPEECH_PROVIDER=deepgram`.
- **Google Cloud STT v2** if the deployment already lives in GCP and wants a
  single vendor with enterprise SLAs.
- **Self-hosted Whisper/Nemotron** if data must never leave our infrastructure;
  the provider interface exists precisely to make that swap a one-file change.

## How it is wired (and what is proven)

Recognition:

- `SpeechProvider` (interface) → `sarvam` / `deepgram` / `mock` / `none`.
- `SPEECH_PROVIDER` selects `auto | sarvam | deepgram | mock | none`; `auto`
  uses Sarvam when `SARVAM_API_KEY` is present, else Deepgram when
  `DEEPGRAM_API_KEY` is.
- Sarvam handles one speaking turn over REST: the adapter buffers the turn's
  WebM/Opus chunks and posts them on `speech:stop`. Capabilities report
  `streaming: true` (audio still streams to our server) but `interim: false`
  (Sarvam returns only a final), so the UI shows no fake partials.
- If the Sarvam POST fails and Deepgram accepts the language, the buffered turn
  is replayed to Deepgram exactly once with interims suppressed — never a
  duplicate final.
- A detected `language_code` from Sarvam replaces the utterance language only
  when it maps to a supported Sangam code and differs from the seat's
  configured language; the seat's own preference is never overwritten by the
  partner's.

Translation: `Sarvam Mayura → Google → Gemini`. Sarvam's catalog is Indic-only,
so a non-Indic pair falls through to the keyless Google endpoint; Gemini (when
configured) backs Google. Each leg is attempted at most once, sequentially.

Playback: `Sarvam Bulbul → Gemini TTS → browser speechSynthesis`. Bulbul's voice
and model come from a per-language registry (the Malayalam entry uses the
documented `bulbul:v3` voice). When no server audio can be produced the
listener receives `conversation:playback_unavailable` and speaks the stored
translation locally — deduplicated, ordered, interrupt-aware, and reset on
leave/disconnect.

**Verified by tests (no live vendor calls):** the Sarvam adapters, both chain
builders, the TTS service `playback_unavailable` emission (including a
full-stack `provider_unavailable` / `unsupported_language` case), language
detection in the speech session, and the browser speech fallback are covered by
mocked unit/integration tests.

**Still unverified:** every path that needs a real credential or a real
browser — live Sarvam/Deepgram audio, live translation, real Bulbul audio, and
actual `speechSynthesis` output. See the manual test procedure in the
integration report.

## Required configuration

| Variable                   | Where   | Purpose                                                                  |
| -------------------------- | ------- | ------------------------------------------------------------------------ |
| `SARVAM_API_KEY`           | server  | Secret, shared by STT + translation + TTS. Never exposed to the browser. |
| `SPEECH_PROVIDER`          | server  | `sarvam`/`deepgram` to require one, `auto` to chain when keys exist.     |
| `SARVAM_STT_MODEL`         | server  | Optional; defaults to `saaras:v4`.                                       |
| `DEEPGRAM_API_KEY`         | server  | Fallback credential; never exposed to the browser.                       |
| `DEEPGRAM_MODEL`           | server  | Optional; defaults to `nova-3`.                                          |
| `TRANSLATION_PROVIDER`     | server  | `auto` chains Sarvam → Google → Gemini when keys exist.                  |
| `SARVAM_TRANSLATION_MODEL` | server  | Optional; defaults to `mayura:v1`.                                       |
| `GEMINI_API_KEY`           | server  | Translation + Gemini-TTS fallback credential.                            |
| `TTS_PROVIDER`             | server  | `auto` chains Sarvam Bulbul → Gemini TTS.                                |
| `SARVAM_TTS_MODEL`         | server  | Optional override; the registry model is the default.                    |
| `SARVAM_TTS_VOICE`         | server  | Optional override; the registry voice is the default.                    |
| `SPEECH_MAX_SESSION_BYTES` | server  | Optional per-turn audio ceiling (default 12 MB).                         |

### Remaining work before claiming production speech

1. Verify Sarvam and Deepgram against live audio in Tamil/Telugu/Hindi and a
   real microphone in Chrome/Brave/Firefox (mocked tests only so far).
2. Confirm live Bulbul playback for each registry voice, and browser
   `speechSynthesis` fallback in a real browser.
3. Add server-side rate limiting/quotas per room and per IP.
4. Decide the retention policy for audio (currently never persisted; only
   transcripts are kept in memory).
