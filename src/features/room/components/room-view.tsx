"use client";

import { CircleAlert, Loader2, Mic, RefreshCw, UserPlus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, buttonClasses } from "@/components/ui/button";
import { ConversationControls } from "@/features/conversation/components/conversation-controls";
import { TextComposer } from "@/features/conversation/components/text-composer";
import { Transcript } from "@/features/conversation/components/transcript";
import { useRoomConversation } from "@/features/room/hooks/use-room-conversation";
import { InviteDialog } from "@/features/room/components/invite-dialog";
import { PreJoinLanguages } from "@/features/room/components/pre-join-languages";
import { RoomHeader } from "@/features/room/components/room-header";
import { RoomStage } from "@/features/room/components/room-stage";
import { StateBanner } from "@/features/room/components/state-banner";
import { languageQuery } from "@/features/room/utils/language-preference";
import type { LanguagePreferences } from "@/features/room/utils/language-preference";
import {
  interruptButtonLabel,
  isInterruptPending,
} from "@/features/room/utils/interrupt-state";
import { ROOM_EXPIRED_CODE } from "@/features/room/utils/connection";
import { roomPath } from "@/features/room/utils/room-path";
import type { RoomMode } from "@/features/room/types";

export interface RoomViewProps {
  readonly code: string;
  readonly mode: RoomMode;
  /** This participant's own validated speaking/listening preferences. */
  readonly preferences: LanguagePreferences;
  /**
   * True when the URL carried no language parameters (bare code-only join).
   * The screen shows an explicit pre-join language choice instead of joining
   * silently with defaults; invite links always carry both parameters and
   * join directly.
   */
  readonly requiresLanguageChoice?: boolean;
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

/**
 * The live conversation room, driven by the real-time server. When the URL
 * carried no language parameters, an explicit pre-join step collects this
 * device's pair first; the chosen pair is written back into the URL so a
 * refresh or reconnect preserves it, then the live room mounts with it.
 */
export function RoomView({
  code,
  mode,
  preferences,
  requiresLanguageChoice = false,
}: RoomViewProps) {
  const router = useRouter();
  const [chosen, setChosen] = useState<LanguagePreferences | null>(null);

  if (requiresLanguageChoice && chosen === null) {
    return (
      <div className="flex min-h-dvh flex-col">
        <main className="flex flex-1 flex-col">
          <PreJoinLanguages
            code={code}
            initial={preferences}
            onJoin={(next) => {
              setChosen(next);
              const query = languageQuery(next);
              router.replace(
                `${roomPath(code)}?${query}${mode === "create" ? "&create=1" : ""}`,
              );
            }}
          />
        </main>
      </div>
    );
  }

  return (
    <RoomLive code={code} mode={mode} preferences={chosen ?? preferences} />
  );
}

interface RoomLiveProps {
  readonly code: string;
  readonly mode: RoomMode;
  readonly preferences: LanguagePreferences;
}

function RoomLive({ code, mode, preferences }: RoomLiveProps) {
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
    nowPlaying,
    canInterrupt,
    interruptState,
    entries,
    interims,
    notice,
    flow,
    broken,
    canSendText,
  } = conversation;

  const interruptLabel = interruptButtonLabel(interruptState);
  const interruptPending = isInterruptPending(interruptState);
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
            roomError.code === ROOM_EXPIRED_CODE ? (
              <StateBanner
                tone="error"
                icon={CircleAlert}
                title="This conversation ended"
                action={
                  <span className="inline-flex gap-2">
                    <Link href="/" className={buttonClasses("outline", "sm")}>
                      Back home
                    </Link>
                    <Button size="sm" onClick={conversation.retryConnection}>
                      <RefreshCw aria-hidden="true" className="size-4" />
                      Try again
                    </Button>
                  </span>
                }
              >
                {roomError.message} Room history cannot be recovered — rooms
                live only in the server&apos;s memory.
              </StateBanner>
            ) : (
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
            )
          ) : null}

          {!roomError && connection === "reconnecting" ? (
            <StateBanner tone="info" icon={RefreshCw} title="Reconnecting">
              The connection dropped — rejoining the room with your languages.
              Sending is paused until the room confirms you.
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

          {!roomError && speechTransport === "server" && !capturing ? (
            <StateBanner tone="info" icon={Mic} title="Server speech available">
              The room server has a speech provider configured. Turn on the
              microphone to have this room transcribed — typing always works.
            </StateBanner>
          ) : null}

          {!roomError && speechTransport === "server" && capturing ? (
            <StateBanner tone="info" icon={Mic} title="Server speech active">
              Recognising on the room server. Interim words appear live;
              finished sentences join the transcript.
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
            {connection === "reconnecting"
              ? "Reconnecting to the room…"
              : "Connecting to the room…"}
          </p>
        ) : (
          <RoomStage
            seats={{ you, partner }}
            speakerStates={speakerStates}
            capturing={capturing}
            nowPlaying={nowPlaying}
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
            playbackStatus={playback.status}
            canInterrupt={canInterrupt}
            interruptLabel={interruptLabel}
            interruptPending={interruptPending}
            disabled={!canSendText}
            onToggleCapture={conversation.toggleCapture}
            onPlaybackAction={conversation.togglePlayback}
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
