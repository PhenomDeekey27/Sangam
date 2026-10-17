This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Sangam setup

Sangam is two processes: this Next.js frontend and the Socket.IO room
server in `server/`. Both need to run for a live conversation.

```bash
# Terminal 1 — room + translation server (http://localhost:4000)
cd server
npm install
npm run dev

# Terminal 2 — frontend (http://localhost:3000)
npm install
npm run dev
```

Copy `.env.example` to `.env.local` (frontend) and `server/.env`
(backend) and fill in real values. Never commit secrets.

Translation order is Google primary → Gemini fallback. A keyless Google
endpoint fronts every utterance (unofficial — fast but not guaranteed, and
it may rate-limit); Gemini API (`gemini-3.5-flash-lite` by default) covers
its failures. Get a key at <https://aistudio.google.com/apikey> and set in
`server/.env`:

```env
TRANSLATION_PROVIDER=auto
GEMINI_API_KEY=your_gemini_api_key
GEMINI_TRANSLATION_MODEL=gemini-3.5-flash-lite
```

`auto` uses the Gemini fallback only when the key is set; `google` disables
the fallback for development; `gemini` requires the key at startup; `none`
leaves transcripts untranslated. Without any provider configured,
transcripts stay untranslated. Speech recognition uses
Deepgram when `DEEPGRAM_API_KEY` is set, otherwise the browser's own
recognition.

## Translated-speech playback

When a listening participant's translation completes, the server
synthesizes audio for it with Gemini TTS (no browser `speechSynthesis`) and
sends it **only to that listener's socket** over `conversation:playback`:
a JSON payload (`utteranceId`, `sequence`, `language`, `mimeType`) plus a
binary WAV frame. The browser plays the frames strictly in the server's
`sequence` order, drops duplicates (repeat frames, history replays, and
reconnect replays never sound twice), and skips a broken frame without
losing the following ones. Original and translated text always render in
the transcript even if synthesis fails.

The same `GEMINI_API_KEY` used for translation covers synthesis, so `auto`
needs no extra setup. Tune it in `server/.env`:

```env
TTS_PROVIDER=auto            # auto | gemini | none
GEMINI_API_KEY=your_gemini_api_key
TTS_MODEL=gemini-3.8-flash-lite-tts
TTS_VOICE=Kore
```

`auto` turns playback on when a synthesis key is available; `gemini`
requires one at startup; `none` disables audio (the text pipeline is
unaffected). If the browser's autoplay policy refuses to start audio, the
client parks the queue in a `blocked` state and resumes with one tap or
key press rather than dropping the speech.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
