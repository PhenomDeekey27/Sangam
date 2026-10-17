# Sangam — Speak Your Language. Understand Each Other.

**Sangam** is a real-time, multilingual conversation app that helps two people communicate even when they speak different languages.

Instead of asking both people to type messages or manually translate every sentence, Sangam lets them speak naturally. The app converts speech into text, translates it into the other person's preferred language, and plays the translated message as audio.

## Live Demo

- **Live application:** https://sangam-blond-seven.vercel.app
- **Source code:** https://github.com/PhenomDeekey27/Sangam

## The Problem

Language barriers can make simple conversations difficult. Two people might understand each other perfectly well if they shared a language, but struggle to communicate because they speak different ones.

Sangam aims to make those conversations more natural by handling transcription, translation and spoken playback in real time.

## How It Works

1. **Create or join a room.** Two participants connect to the same conversation using a room code or invitation.
2. **Choose your languages.** Each participant configures their own speaking and listening language preferences.
3. **Speak naturally.** The app captures the speaker's microphone audio.
4. **Convert speech to text.** The speech recognition service generates a transcript.
5. **Translate the message.** The transcript is translated into the other participant's preferred language.
6. **Play the translation.** Text-to-speech generates audio so the listener can hear the translated message.
7. **Interrupt and respond.** Participants can interrupt a response and continue the conversation without intentionally replaying stale audio from an interrupted turn.

The same process works in the opposite direction, allowing both participants to speak in their own languages.

## Try the Live App

1. Open the live application in two separate browser tabs or on two devices.
2. Create a conversation room and have the second participant join it.
3. Set each participant's speaking and listening language preferences.
4. Allow microphone access when prompted.
5. Speak a short sentence in one tab and check the transcript, translation and audio in the other.
6. Reply from the second participant to test the reverse direction.
7. Try interrupting a spoken response and verify that the conversation continues.

For the best experience, use a supported browser, allow microphone access, and ensure both participants have a working internet connection.

## Technology Stack

### Frontend
- Next.js and React
- TypeScript
- Tailwind CSS
- Socket.IO client
- Web Audio and browser speech capabilities where appropriate

### Backend
- Node.js
- Express
- TypeScript
- Socket.IO

### AI and Language Services
- **Sarvam AI:** Preferred speech-to-text, text translation and text-to-speech provider.
- **Deepgram:** Speech-to-text fallback.
- **Google translation:** Translation fallback.
- **Google Gemini:** Translation and text-to-speech fallback.
- **Browser speech synthesis:** Best-effort fallback when server-generated speech is unavailable.

The backend uses provider-specific adapters and language mappings to handle supported language codes, models and voices. Provider availability and supported languages vary by service.

## Key Features

- Two-person, bidirectional multilingual conversations.
- Individual speaking and listening language preferences.
- Speech-to-text, text translation and spoken translation.
- Real-time communication using Socket.IO.
- Provider fallback handling when a service is unavailable or a language is unsupported.
- Interruption-aware playback, including protection against stale audio.
- Language preference changes for subsequent utterances.
- Automated unit, integration and browser tests.

## Architecture Overview

```text
Participant A
     |
     v
Microphone Audio
     |
     v
Speech-to-Text
     |
     v
Text Translation
     |
     v
Text-to-Speech
     |
     v
Participant B hears translated audio

The same pipeline works in reverse.
```

The Next.js frontend is deployed on Vercel. The Express and Socket.IO backend is deployed separately on Render.

## Run Locally

### Prerequisites

- Node.js and npm
- A Sarvam API key for the preferred AI services
- Optional provider credentials for the configured fallbacks

### 1. Clone the repository

```bash
git clone https://github.com/PhenomDeekey27/Sangam.git
cd Sangam
npm install
```

### 2. Configure the frontend

Create the appropriate frontend environment file and configure:

```env
NEXT_PUBLIC_SOCKET_URL=http://localhost:3001
```

Replace the URL with the actual local backend address if your server uses a different port.

### 3. Configure the backend

Create `server/.env` using `server/.env.example` as a reference.

At minimum, configure the Sarvam key if you want to use Sarvam:

```env
SARVAM_API_KEY=your_sarvam_api_key
```

Add optional fallback provider credentials as required by your chosen configuration.

Set `CLIENT_ORIGIN` to the exact local frontend origin, for example:

```env
CLIENT_ORIGIN=http://localhost:3000
```

Check `server/.env.example` and the backend configuration for the complete list of supported variables and defaults.

### 4. Start the backend

Open a terminal:

```bash
cd server
npm install
npm run dev
```

### 5. Start the frontend

Open a second terminal from the repository root:

```bash
npm run dev
```

Open the local URL printed by Next.js and join a room using two browser tabs.

**Note:** The commands above assume the local frontend uses port 3000 and the backend uses port 3001. Use the actual ports configured in the repository if they differ.

## Environment Variables

Never commit actual API keys or secret values.

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_SOCKET_URL` | Frontend URL for the Socket.IO backend |
| `CLIENT_ORIGIN` | Allowed frontend origin for backend requests |
| `SARVAM_API_KEY` | Sarvam authentication for supported speech and language services |
| `SPEECH_PROVIDER` | Speech provider selection |
| `SARVAM_STT_MODEL` | Sarvam speech-to-text model |
| `DEEPGRAM_API_KEY` | Deepgram speech recognition fallback |
| `DEEPGRAM_MODEL` | Deepgram model selection |
| `TRANSLATION_PROVIDER` | Translation provider selection |
| `SARVAM_TRANSLATION_MODEL` | Sarvam translation model |
| `GEMINI_API_KEY` | Gemini authentication for configured fallback services |
| `GEMINI_TRANSLATION_MODEL` | Gemini translation model |
| `TTS_PROVIDER` | Text-to-speech provider selection |
| `TTS_API_KEY` | Credential used by the configured TTS provider, where required |
| `TTS_MODEL` | Existing TTS model configuration |
| `TTS_VOICE` | Existing TTS voice configuration |
| `SARVAM_TTS_MODEL` | Sarvam speech-generation model |
| `SARVAM_TTS_VOICE` | Sarvam voice configuration |
| `SPEECH_MAX_SESSION_BYTES` | Maximum audio bytes permitted for a speech session |

Provider values and defaults are defined in the backend configuration and `server/.env.example`. Not every variable is required for every configuration.

Keep all secret keys in the backend environment. Do not expose them through `NEXT_PUBLIC_*` variables or commit `.env` files.

## Testing

The project includes automated frontend, backend and end-to-end tests.

From the repository root:

```bash
npm test
npm run test:e2e
npm run test:e2e:wire
npm run typecheck
npm run lint
npm run check:file-length
```

Backend tests can be run from the `server` directory:

```bash
npm test
npm run typecheck
```

The end-to-end suite covers simulated conversations, playback interruptions, stale-audio protection, language changes and fallback behavior. Mocked tests do not replace live verification with actual AI providers and microphone audio.

## Deployment

- **Frontend:** Vercel
- **Backend:** Render
- **Real-time communication:** Socket.IO
- **Configuration:** Frontend and backend environment variables configured separately

The deployed frontend must point to the deployed backend URL. The backend must allow the deployed frontend origin and have the required provider credentials configured.

## Current Limitations

- Language availability depends on the capabilities of the selected speech, translation and TTS providers.
- Speech recognition, translation quality and response latency can vary with language, audio quality and network conditions.
- Browser-native speech synthesis depends on the browser and installed voices.
- Automated tests cover simulated scenarios; real devices and live provider behavior should also be tested.
- Conversation transcripts are not intended to be permanently stored by this application unless persistence is explicitly implemented.

## Security

- API keys belong in backend environment variables.
- Never commit `.env` or `.env.local` files containing secrets.
- Avoid logging API keys, raw audio or unnecessary personal conversation content.

## Project Status

Sangam has a deployed frontend and backend, automated test coverage, provider fallbacks and bidirectional conversation support. Real-world behavior depends on network conditions, browser permissions and the configured AI providers.

