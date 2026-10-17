/**
 * Client→server conversation actions for the room screen. Kept out of the hook
 * so the send paths (typed message, recognition final, interim line,
 * interrupt) read as one small policy surface: nothing is emitted unless this
 * client is a confirmed member of a connected socket.
 */
import { newUtteranceId } from "@/features/conversation/utils/utterance-id";
import {
  getRoomSocket,
  type RoomSocket,
} from "@/features/room/services/socket";
import { ROOM_JOIN_TIMEOUT_MS } from "@/features/room/utils/connection";
import type { LanguageCode } from "@/types";
import type { InterruptAck, RoomOpAck, SocketError } from "@/types/socket";
import type { RoomMode, SpeakerSide } from "@/features/room/types";

/** Everything the actions need; the caller rebuilds them when it changes. */
export interface RoomActionContext {
  readonly language: LanguageCode;
  /** Server-assigned participant id once this client is seated, else `null`. */
  readonly selfId: string | null;
  /** Whether the partner is currently in the room. */
  readonly partnerPresent: boolean;
  readonly notify: (message: string | null) => void;
}

/** Callbacks the caller supplies for one interruption request. */
export interface InterruptRequestHandlers {
  /** Fires the instant the request is emitted, before any server reply. */
  readonly onRequested: (interruptId: string) => void;
  /** Resolves the request with the server's ack. */
  readonly onAck: (response: InterruptAck, interruptId: string) => void;
}

export interface RoomActions {
  /** Relay a finalized utterance under a fresh client-generated id. */
  readonly sendUtterance: (text: string, source: "typed" | "speech") => void;
  /** Send the current interim line; empty text clears the partner's view. */
  readonly emitInterim: (text: string) => void;
  /**
   * Ask the server to interrupt the partner. Returns silently unless this
   * client is a seated member of a connected socket; the identifier and ack
   * are surfaced to the caller through `handlers`.
   */
  readonly interrupt: (handlers: InterruptRequestHandlers) => void;
}

export function createRoomActions(context: RoomActionContext): RoomActions {
  /** The socket, but only while this client is a seated room member. */
  const memberSocket = (): RoomSocket | null => {
    const socket = getRoomSocket();
    return socket.connected && context.selfId !== null ? socket : null;
  };

  const sendUtterance = (raw: string, source: "typed" | "speech"): void => {
    const text = raw.trim();
    if (!text) return;
    const socket = memberSocket();
    if (!socket) {
      context.notify("Not connected — reconnect before sending messages.");
      return;
    }
    socket.emit("conversation:utterance", {
      utteranceId: newUtteranceId(),
      text,
      language: context.language,
    });
    if (source === "typed") {
      context.notify(
        context.partnerPresent
          ? "Message sent — translation is not applied yet, so it arrives as-is."
          : "Nobody else is connected — only this room's live transcript has your message.",
      );
    } else if (!context.partnerPresent) {
      context.notify(
        "Nobody else is connected yet — your words are in this room's transcript.",
      );
    }
  };

  const emitInterim = (text: string): void => {
    memberSocket()?.emit("conversation:interim", {
      text,
      language: context.language,
    });
  };

  /**
   * Ask the server to interrupt the partner. The click only arms a request:
   * the requester's UI must wait for the partner's confirmation before it
   * claims any playback was stopped, and it must never touch its own audio.
   */
  const interrupt = (handlers: InterruptRequestHandlers): void => {
    const socket = memberSocket();
    if (!socket) return;
    const interruptId = newUtteranceId();
    handlers.onRequested(interruptId);
    socket.emit("conversation:interrupt", { interruptId }, (response) => {
      handlers.onAck(response, interruptId);
    });
  };

  return { sendUtterance, emitInterim, interrupt };
}

/** One participant's preferences for a create/join emit. */
export interface RoomJoinAttempt {
  readonly code: string;
  readonly language: LanguageCode;
  readonly listeningLanguage: LanguageCode;
}

/** Side effects of a create/join round trip, owned by the calling hook. */
export interface RoomJoinEffects {
  readonly notify: (message: string | null) => void;
  readonly silence: () => void;
  readonly onRoomError: (error: SocketError) => void;
  readonly onJoined: (
    self: { readonly id: string; readonly side: SpeakerSide },
    created: boolean,
  ) => void;
  /**
   * The server never answered within the deadline (backend gone mid-join).
   * The caller should leave `connecting`/`reconnecting` for a retryable
   * state instead of waiting forever. Late acks after this are ignored.
   */
  readonly onTimeout?: () => void;
}

/** Per-attempt options for a create/join round trip. */
export interface RoomJoinOptions {
  /**
   * Ack deadline per leg in milliseconds. Defaults to
   * `ROOM_JOIN_TIMEOUT_MS`; the timer never holds the process open.
   */
  readonly timeoutMs?: number;
}

/**
 * Send a `room:create`/`room:join` for one seat. Both preferences ride along,
 * so the seat the server (re-)creates carries the same languages. When the
 * invite URL is opened before the creator's screen finishes creating, the
 * refused create falls back to joining the existing room. Every leg has an
 * ack deadline so a backend that dies mid-join cannot leave the UI stuck.
 */
export function emitRoomJoin(
  socket: RoomSocket,
  attempt: RoomMode,
  join: RoomJoinAttempt,
  effects: RoomJoinEffects,
  options?: RoomJoinOptions,
): void {
  const payload = {
    code: join.code,
    language: join.language,
    listeningLanguage: join.listeningLanguage,
  };
  const timeoutMs = options?.timeoutMs ?? ROOM_JOIN_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settled = false;
  const disarm = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
  const arm = (onTimeout: () => void): void => {
    disarm();
    timer = setTimeout(onTimeout, timeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  };
  const send = (next: RoomMode): void => {
    const onResponse = (response: RoomOpAck): void => {
      if (settled) return;
      if (
        next === "create" &&
        !response.ok &&
        response.error.code === "room_already_exists"
      ) {
        send("join");
        return;
      }
      settled = true;
      disarm();
      if (!response.ok) {
        effects.onRoomError(response.error);
        effects.silence();
        return;
      }
      effects.onJoined(response.self, next === "create");
    };
    arm(() => {
      if (settled) return;
      settled = true;
      effects.onTimeout?.();
    });
    if (next === "create") {
      socket.emit("room:create", payload, onResponse);
    } else {
      socket.emit("room:join", payload, onResponse);
    }
  };
  send(attempt);
}
