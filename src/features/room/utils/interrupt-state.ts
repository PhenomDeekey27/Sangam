/**
 * Pure state machine for the *requester* side of an interruption.
 *
 * An interruption is a two-step round trip: this client asks the server, the
 * server relays the request to the partner, and the partner confirms once its
 * own playback actually stopped. The requester must therefore never claim the
 * partner's audio was stopped from the click alone — only the partner's
 * confirmation means the cancellation happened. Every transition here is pure
 * and additive, so the hook can drive it from socket events and a timeout
 * without any hidden side effects.
 */

/** How the requester's interruption is progressing. */
export type InterruptPhase = "ready" | "requesting" | "confirmed" | "error";

/** Why an interruption ended in `error`. */
export type InterruptErrorReason =
  | "not_relayed"
  | "refused"
  | "timeout"
  | "disconnected";

export interface InterruptState {
  readonly phase: InterruptPhase;
  /** The in-flight (or just-settled) request id; `null` when idle. */
  readonly interruptId: string | null;
  readonly reason: InterruptErrorReason | null;
}

export const INITIAL_INTERRUPT_STATE: InterruptState = {
  phase: "ready",
  interruptId: null,
  reason: null,
};

/** How long to wait for the server ack before giving up with a retry. */
export const INTERRUPT_REQUEST_TIMEOUT_MS = 2500;

/** How long the confirmed state lingers before the button is usable again. */
export const INTERRUPT_CONFIRM_RESET_MS = 1800;

export type InterruptEvent =
  | { readonly type: "request"; readonly interruptId: string }
  | {
      readonly type: "ack";
      readonly interruptId: string;
      readonly ok: boolean;
      readonly relayed: boolean;
    }
  | { readonly type: "confirmed"; readonly interruptId: string }
  | { readonly type: "timeout"; readonly interruptId: string }
  | { readonly type: "disconnected" }
  | { readonly type: "reset" };

/**
 * Advance the requester's interruption state. Events for a superseded request
 * id are ignored, so a late ack or confirmation from an older attempt can
 * never settle a newer one.
 */
export function reduceInterrupt(
  state: InterruptState,
  event: InterruptEvent,
): InterruptState {
  switch (event.type) {
    case "request":
      return {
        phase: "requesting",
        interruptId: event.interruptId,
        reason: null,
      };
    case "ack":
      if (state.interruptId !== event.interruptId) return state;
      if (!event.ok) {
        return {
          phase: "error",
          interruptId: event.interruptId,
          reason: "refused",
        };
      }
      if (!event.relayed) {
        return {
          phase: "error",
          interruptId: event.interruptId,
          reason: "not_relayed",
        };
      }
      // Delivered, not yet confirmed: the partner has not cancelled anything.
      return state;
    case "confirmed":
      if (state.interruptId !== event.interruptId) return state;
      return { phase: "confirmed", interruptId: event.interruptId, reason: null };
    case "timeout":
      if (state.phase !== "requesting" || state.interruptId !== event.interruptId) {
        return state;
      }
      return {
        phase: "error",
        interruptId: event.interruptId,
        reason: "timeout",
      };
    case "disconnected":
      if (state.phase === "ready") return state;
      return {
        phase: "error",
        interruptId: state.interruptId,
        reason: "disconnected",
      };
    case "reset":
      return INITIAL_INTERRUPT_STATE;
  }
}

/** True while a request is in flight; the button stays disabled meanwhile. */
export function isInterruptPending(state: InterruptState): boolean {
  return state.phase === "requesting";
}

/** Clear button copy for the current phase. */
export function interruptButtonLabel(state: InterruptState): string {
  switch (state.phase) {
    case "requesting":
      return "Interrupting…";
    case "confirmed":
      return "Interrupted";
    case "error":
      return "Retry interrupt";
    case "ready":
      return "Interrupt";
  }
}

/**
 * Requester-facing notice, or `null` when there is nothing to report. The
 * `confirmed` copy is deliberately the only one that says the audio stopped,
 * so the click itself never overstates what happened.
 */
export function interruptNotice(state: InterruptState): string | null {
  switch (state.phase) {
    case "requesting":
      return "Asking your partner to pause…";
    case "confirmed":
      return "Interrupt confirmed — your partner's device stopped the interrupted audio.";
    case "error":
      switch (state.reason) {
        case "not_relayed":
          return "Nobody else is in the room, so there was nothing to interrupt.";
        case "refused":
          return "The room refused the interruption — try again.";
        case "disconnected":
          return "Connection lost — the interruption was not confirmed.";
        case "timeout":
        default:
          return "Your partner did not confirm the interruption — you can try again.";
      }
    case "ready":
      return null;
  }
}
