/**
 * Deterministic development/test speech provider.
 *
 * It performs no recognition: it emits a scripted interim on the first audio
 * chunk and a scripted final once enough audio has arrived or the session is
 * stopped. That is enough to exercise the whole server pipeline — session
 * limits, room relay, transcript ordering, deduplication, and cleanup — without
 * credentials or a real microphone. It is never selected automatically: the
 * server only uses it when `SPEECH_PROVIDER=mock` is set explicitly.
 */
import type {
  SpeechProvider,
  SpeechProviderListeners,
  SpeechProviderSession,
} from "./provider.js";
import { SUPPORTED_LANGUAGE_CODES } from "../rooms/room-validation.js";

export interface MockSpeechScript {
  /** Partial line emitted after the first chunk. `{language}` is substituted. */
  readonly interim: string;
  /** Final line emitted once enough audio has arrived. */
  readonly final: string;
  /** Bytes that must arrive before the final is produced. */
  readonly finalAfterBytes: number;
}

export const DEFAULT_MOCK_SCRIPT: MockSpeechScript = {
  interim: "[mock] hearing {language}…",
  final: "[mock] recognized {language}",
  finalAfterBytes: 1,
};

function substitute(template: string, language: string): string {
  return template.replaceAll("{language}", language);
}

export function createMockSpeechProvider(
  script: MockSpeechScript = DEFAULT_MOCK_SCRIPT,
): SpeechProvider {
  return {
    id: "mock",
    streaming: true,
    interim: true,
    languages: SUPPORTED_LANGUAGE_CODES,
    open(options) {
      return createSession(options, script);
    },
  };
}

function createSession(
  options: { language: string } & SpeechProviderListeners,
  script: MockSpeechScript,
): SpeechProviderSession {
  let bytes = 0;
  let interimSent = false;
  let finalized = false;
  let closed = false;

  const finalize = (): void => {
    if (finalized || closed) return;
    finalized = true;
    options.onFinal(substitute(script.final, options.language));
    options.onClose();
  };

  return {
    push(chunk) {
      if (closed || finalized) return;
      bytes += chunk.byteLength;
      if (!interimSent && chunk.byteLength > 0) {
        interimSent = true;
        options.onInterim(substitute(script.interim, options.language));
      }
      if (bytes >= script.finalAfterBytes) finalize();
    },
    stop() {
      // A closing turn still reports whatever was heard, then closes.
      if (bytes > 0) finalize();
      else if (!closed) options.onClose();
    },
    close() {
      closed = true;
    },
  };
}
