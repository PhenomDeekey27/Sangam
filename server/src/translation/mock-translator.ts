/**
 * Scripted test double for `Translator`. Test-only: it never calls a vendor
 * and never invents translations on its own — every response (or failure) is
 * explicitly scripted by the test, so mocked runs are unmistakable in logs.
 */
import {
  TranslationProviderError,
  type TranslationResult,
  type TranslationRequest,
  type Translator,
  type TranslationFailureCode,
} from "./translator.js";

export interface MockScript {
  /** Canned outputs keyed `source -> target -> input text`. */
  readonly canned?: Readonly<
    Record<string, Readonly<Record<string, Readonly<Record<string, string>>>>>
  >;
  /** Failures keyed the same way; thrown instead of resolving. */
  readonly failures?: Readonly<
    Record<
      string,
      Readonly<Record<string, Readonly<Record<string, TranslationFailureCode>>>>
    >
  >;
  /**
   * When true, `translate` waits for `release()` instead of resolving from
   * the script — lets tests order completions and simulate disconnects.
   */
  readonly deferred?: boolean;
}

export class MockTranslator implements Translator {
  readonly calls: TranslationRequest[] = [];
  private readonly script: MockScript;
  private releaseWaiters: Array<() => void> = [];

  constructor(script: MockScript = {}) {
    this.script = script;
  }

  /** Let all deferred translations proceed. */
  release(): void {
    const waiters = this.releaseWaiters;
    this.releaseWaiters = [];
    for (const waiter of waiters) waiter();
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    this.calls.push(request);
    if (this.script.deferred) {
      await new Promise<void>((resolve) => {
        this.releaseWaiters.push(resolve);
      });
    }
    const failure =
      this.script.failures?.[request.sourceLanguage]?.[
        request.targetLanguage
      ]?.[request.text];
    if (failure) {
      throw new TranslationProviderError(failure, `mocked ${failure}`);
    }
    const text =
      this.script.canned?.[request.sourceLanguage]?.[request.targetLanguage]?.[
        request.text
      ];
    if (text === undefined) {
      throw new TranslationProviderError(
        "unknown",
        "mock translator has no canned response for this request",
      );
    }
    return { text, targetLanguage: request.targetLanguage };
  }
}
