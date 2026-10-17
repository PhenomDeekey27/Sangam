"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpeakerState } from "@/features/conversation/types";
import { SPEAKING_RESET_MS } from "@/features/room/hooks/subscribe-room-socket";
import {
  INITIAL_INTERRUPT_STATE,
  INTERRUPT_CONFIRM_RESET_MS,
  INTERRUPT_REQUEST_TIMEOUT_MS,
  interruptButtonLabel,
  interruptNotice,
  isInterruptPending,
  reduceInterrupt,
  type InterruptState,
} from "@/features/room/utils/interrupt-state";
import type { InterruptAck } from "@/types/socket";

/** Callbacks `room-actions` surfaces for one emitted interruption request. */
export interface InterruptRequestHandlers {
  readonly onRequested: (interruptId: string) => void;
  readonly onAck: (response: InterruptAck, interruptId: string) => void;
}

export interface InterruptRequesterOptions {
  /** Emit the request; a no-op unless this client is a seated member. */
  readonly sendRequest: (
    handlers: InterruptRequestHandlers,
  ) => void;
  readonly notify: (message: string | null) => void;
  readonly setPartnerState: (state: SpeakerState) => void;
  readonly schedule: (callback: () => void, ms: number) => void;
}

export interface InterruptRequester {
  readonly state: InterruptState;
  /** A request is in flight; the button stays disabled and shows a spinner. */
  readonly pending: boolean;
  readonly label: string;
  /** Ask to interrupt the partner (safe to call from a click handler). */
  readonly request: () => void;
  /** The partner confirmed its playback actually stopped. */
  readonly confirm: (interruptId: string) => void;
  /** The transport dropped while a request was still unresolved. */
  readonly disconnect: () => void;
}

/**
 * Owns the requester side of an interruption: the phase state machine, the
 * ack deadline, and the notice copy. The click only arms a `requesting`
 * state; the server's ack confirms delivery, and only the partner's own
 * confirmation declares the cancellation. Own playback is never touched here
 * — the interruption targets the partner's device, not this one.
 */
export function useInterruptRequester(
  options: InterruptRequesterOptions,
): InterruptRequester {
  const [state, setState] = useState<InterruptState>(INITIAL_INTERRUPT_STATE);
  // Read through a ref so the callbacks keep stable identities and the socket
  // subscription is not torn down when a prop identity changes.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const requestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** The request id still awaiting a confirmation (or `null`). */
  const activeIdRef = useRef<string | null>(null);

  const clearRequestTimer = useCallback(() => {
    if (requestTimerRef.current !== null) {
      clearTimeout(requestTimerRef.current);
      requestTimerRef.current = null;
    }
  }, []);

  const clearResetTimer = useCallback(() => {
    if (resetTimerRef.current !== null) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
  }, []);

  const arm = useCallback(
    (interruptId: string) => {
      activeIdRef.current = interruptId;
      clearRequestTimer();
      setState((current) =>
        reduceInterrupt(current, { type: "request", interruptId }),
      );
      requestTimerRef.current = setTimeout(() => {
        requestTimerRef.current = null;
        setState((current) =>
          reduceInterrupt(current, { type: "timeout", interruptId }),
        );
      }, INTERRUPT_REQUEST_TIMEOUT_MS);
    },
    [clearRequestTimer],
  );

  const settle = useCallback(
    (response: InterruptAck, interruptId: string) => {
      // A relayed request keeps waiting for the partner's confirmation; every
      // other ack is terminal, so its deadline is disarmed.
      if (!response.ok || !response.relayed) {
        clearRequestTimer();
        if (activeIdRef.current === interruptId) activeIdRef.current = null;
      }
      setState((current) =>
        reduceInterrupt(current, {
          type: "ack",
          interruptId,
          ok: response.ok,
          relayed: response.ok ? response.relayed : false,
        }),
      );
    },
    [clearRequestTimer],
  );

  const request = useCallback(() => {
    optionsRef.current.sendRequest({ onRequested: arm, onAck: settle });
  }, [arm, settle]);

  const confirm = useCallback(
    (interruptId: string) => {
      // Ignore a confirmation for a superseded request.
      if (activeIdRef.current !== interruptId) return;
      clearRequestTimer();
      setState((current) =>
        reduceInterrupt(current, { type: "confirmed", interruptId }),
      );
      // Reflect the cut turn here too, then re-arm the button after a beat.
      const { setPartnerState, schedule } = optionsRef.current;
      setPartnerState("interrupted");
      schedule(() => setPartnerState("idle"), SPEAKING_RESET_MS);
      clearResetTimer();
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        activeIdRef.current = null;
        setState(INITIAL_INTERRUPT_STATE);
      }, INTERRUPT_CONFIRM_RESET_MS);
    },
    [clearResetTimer, clearRequestTimer],
  );

  const disconnect = useCallback(() => {
    clearRequestTimer();
    clearResetTimer();
    activeIdRef.current = null;
    setState((current) => reduceInterrupt(current, { type: "disconnected" }));
  }, [clearRequestTimer, clearResetTimer]);

  // Report each phase change through the shared notice region. `ready` yields
  // `null`, so returning to idle never clears a newer, unrelated notice.
  useEffect(() => {
    const message = interruptNotice(state);
    if (message !== null) optionsRef.current.notify(message);
  }, [state]);

  // Never leave a requester timer running after unmount.
  useEffect(() => {
    return () => {
      if (requestTimerRef.current !== null) {
        clearTimeout(requestTimerRef.current);
      }
      if (resetTimerRef.current !== null) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  return {
    state,
    pending: isInterruptPending(state),
    label: interruptButtonLabel(state),
    request,
    confirm,
    disconnect,
  };
}
