/**
 * Client→server conversation actions for the room screen. Kept out of the hook
 * so the send paths (typed message, recognition final, interim line,
 * interrupt) read as one small policy surface: nothing is emitted unless this
 * client is a confirmed member of a connected socket.
 */
import type { SpeakerState } from "@/features/conversation/types";
import { newUtteranceId } from "@/features/conversation/utils/utterance-id";
import {
  getRoomSocket,
  type RoomSocket,
} from "@/features/room/services/socket";
import type { LanguageCode } from "@/types";

/** How long a turn highlight lingers before seats return to idle. */
const TURN_RESET_MS = 1400;

/** Everything the actions need; the caller rebuilds them when it changes. */
export interface RoomActionContext {
  readonly language: LanguageCode;
  /** Server-assigned participant id once this client is seated, else `null`. */
  readonly selfId: string | null;
  /** Whether the partner is currently in the room. */
  readonly partnerPresent: boolean;
  readonly notify: (message: string | null) => void;
  readonly setSelfState: (state: SpeakerState) => void;
  readonly setPartnerState: (state: SpeakerState) => void;
  /** Cancel pending turn timers before starting a new turn. */
  readonly clearTimers: () => void;
  readonly schedule: (callback: () => void, ms: number) => void;
}

export interface RoomActions {
  /** Relay a finalized utterance under a fresh client-generated id. */
  readonly sendUtterance: (text: string, source: "typed" | "speech") => void;
  /** Send the current interim line; empty text clears the partner's view. */
  readonly emitInterim: (text: string) => void;
  readonly interrupt: () => void;
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

  const interrupt = (): void => {
    const socket = memberSocket();
    if (!socket) return;
    socket.emit("conversation:interrupt");
    context.clearTimers();
    context.setSelfState("speaking");
    context.setPartnerState("interrupted");
    context.notify(
      context.partnerPresent
        ? "You interrupted your partner."
        : "Interrupted — nobody else is in the room right now.",
    );
    context.schedule(() => {
      context.setSelfState("idle");
      context.setPartnerState("idle");
    }, TURN_RESET_MS);
  };

  return { sendUtterance, emitInterim, interrupt };
}
