"use client";

import { Dialog } from "@/components/ui/dialog";
import { CopyField } from "@/features/room/components/copy-field";
import { roomPath } from "@/features/room/utils/room-path";
import { languageLabel } from "@/features/translation/data/languages";
import type { LanguageCode } from "@/types";

export interface InviteDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly code: string;
  readonly youLanguage: LanguageCode;
  readonly partnerLanguage: LanguageCode;
}

/** Invite sheet: the code to read aloud and the link to paste anywhere. */
export function InviteDialog({
  open,
  onClose,
  code,
  youLanguage,
  partnerLanguage,
}: InviteDialogProps) {
  /*
   * Computed during render, never in an effect: the dialog only opens from a
   * user action, so `window` is guaranteed to exist by then and no server
   * render can produce a mismatched URL. The partner speaks what you want to
   * hear and hears what you speak, so the languages swap across the invite.
   */
  const inviteUrl =
    open && typeof window !== "undefined"
      ? (() => {
          const params = new URLSearchParams({
            speak: partnerLanguage,
            hear: youLanguage,
          });
          return `${window.location.origin}${roomPath(code)}?${params.toString()}`;
        })()
      : "";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite your partner"
      description={`You speak ${languageLabel(youLanguage)} and hear everything in it. Your partner speaks ${languageLabel(partnerLanguage)} and hears you in theirs.`}
    >
      <div className="space-y-3">
        <CopyField label="Room code" value={code} display={code} />
        <CopyField
          label="Invite link"
          value={inviteUrl}
          display={inviteUrl || "Preparing link…"}
        />
        <p className="text-mute text-xs">
          Anyone with this code joins the same two-person room. Codes ignore
          case and leave out look-alike characters.
        </p>
      </div>
    </Dialog>
  );
}
