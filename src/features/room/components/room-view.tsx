"use client";

import { CircleAlert, Loader2, RefreshCw, UserPlus } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ConversationControls } from "@/features/conversation/components/conversation-controls";
import { TextComposer } from "@/features/conversation/components/text-composer";
import { Transcript } from "@/features/conversation/components/transcript";
import { useRoomConversation } from "@/features/room/hooks/use-room-conversation";
import { InviteDialog } from "@/features/room/components/invite-dialog";
import { RoomHeader } from "@/features/room/components/room-header";
import { RoomStage } from "@/features/room/components/room-stage";
import { StateBanner } from "@/features/room/components/state-banner";
import type { LanguagePreferences } from "@/features/room/utils/language-preference";
import type { RoomMode } from "@/features/room/types";

export interface RoomViewProps {
  readonly code: string;
  readonly mode: RoomMode;
  /** This participant's own validated speaking/listening preferences. */
  readonly preferences: LanguagePreferences;
}

/** Author label per side: always "You" for your own seat. */
function authorNames(
  youSide: "a" | "b",
  partnerName: string | null,
): Record<"a" | "b", string> {
  const you = "You";
  const partner = partnerName ?? "Partner";
  return youSide === "a" ? { a: you, b: partner } : { a: partner, b: you };
}

/** The live conversation room, driven by the real-time server. */
export function RoomView({ code, mode, preferences }: RoomViewProps) {
  const conversation = useRoomConversation({ code, mode, preferences });
  const [inviteOpen, setInviteOpen] = useState(false);

  const {
    connection,
    roomError,
    mic,
    speechSupport,
    speechTransport,
    recognitionStatus,
    recognitionError,
    you,
    partner,
    speakerStates,
    capturing,
    playback,
    entries,
    interims,
    notice,
    flow,
    broken,
    canSendText,
  } = conversation;

  const playing = playback.status === "playing";
  const canInterrupt = connection === "connected" && you !== null;
  const waiting = connection === "connected" && you !== null && !partner;

  return (
    <div className="flex min-h-dvh flex-col">
      <RoomHeader
        code={code}
        connection={connection}
        onInvite={() => setInviteOpen(true)}
      />

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-4 px-3 py-4 sm:px-5">
        <div className="flex flex-col gap-3">
          {roomError ? (
            <StateBanner
              tone="error"
              icon={CircleAlert}
              title="Could not enter the room"
              action={
                <Button size="sm" onClick={conversation.retryConnection}>
                  <RefreshCw aria-hidden="true" className="size-4" />
                  Try again
                </Button>
              }
            >
              {roomError.message}
            </StateBanner>
          ) : null}

          {!roomError && connection === "failed" ? (
            <StateBanner
              tone="error"
              icon={CircleAlert}
              title="Connection lost"
              action={
                <Button size="sm" onClick={conversation.retryConnection}>
                  <RefreshCw aria-hidden="true" className="size-4" />
                  Reconnect
                </Button>
              }
            >
              The room server could not be reached. Typed messages cannot be
              sent until the connection is back.
            </StateBanner>
          ) : null}

          {!roomError && speechSupport === "unsupported" ? (
            <StateBanner
              tone="info"
              icon={CircleAlert}
              title="Microphone unavailable"
            >
              Speech recognition isn&apos;t supported in this browser — try
              Chrome, Edge, or Safari, or use the text composer below.
            </StateBanner>
          ) : null}

          {!roomError && speechSupport === "supported" && recognitionError ? (
            <StateBanner
              tone="error"
              icon={CircleAlert}
              title="Microphone problem"
            >
              {recognitionError.message}
            </StateBanner>
          ) : null}

          {!roomError && speechTransport === "browser" ? (
            <StateBanner
              tone="info"
              icon={CircleAlert}
              title="Using your browser's speech recognition"
            >
              This room has no server speech provider configured, so recognition
              runs in the browser. Results vary between browsers — Chrome and
              Edge are the most reliable, Brave may block the service, and
              Indic-language accuracy can be uneven. Typing always works.
            </StateBanner>
          ) : null}

          {waiting ? (
            <StateBanner
              tone="info"
              icon={UserPlus}
              title="Waiting for your partner"
              action={
                <Button size="sm" onClick={() => setInviteOpen(true)}>
                  <UserPlus aria-hidden="true" className="size-4" />
                  Invite
                </Button>
              }
            >
              Share the room code <strong>{code}</strong> so they can join.
            </StateBanner>
          ) : null}
        </div>

        {you === null && !roomError ? (
          <p
            role="status"
            aria-live="polite"
            className="border-line text-mute flex items-center gap-2 rounded-2xl border border-dashed px-4 py-8 text-sm"
          >
            <Loader2 aria-hidden="true" className="blink size-4" />
            Connecting to the room…
          </p>
        ) : (
          <RoomStage
            seats={{ you, partner }}
            speakerStates={speakerStates}
            capturing={capturing}
            playing={playing}
            flow={flow}
            bridgeLabel={conversation.bridgeLabel}
            broken={broken}
          />
        )}

        <Transcript
          entries={entries}
          interims={interims}
          authorNames={authorNames(
            you?.side ?? "a",
            partner?.displayName ?? null,
          )}
          className="h-72 lg:h-80"
        />

        <div className="glass border-line sticky bottom-0 z-20 mt-auto flex flex-col gap-3 rounded-t-3xl border-t px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:rounded-3xl sm:border">
          <p
            role="status"
            aria-live="polite"
            className="text-mute min-h-5 px-1 text-xs"
          >
            {notice ?? ""}
          </p>
          <ConversationControls
            capturing={capturing}
            mic={mic}
            recognitionStatus={recognitionStatus}
            playing={playing}
            canInterrupt={canInterrupt}
            disabled={!canSendText}
            onToggleCapture={conversation.toggleCapture}
            onStopPlayback={conversation.stopPlayback}
            onInterrupt={conversation.interrupt}
          />
          <TextComposer
            disabled={!canSendText}
            onSend={conversation.sendText}
          />
        </div>
      </main>

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        code={code}
        preferences={preferences}
      />
    </div>
  );
}
