"use client";

import { Dialog } from "@/components/ui/dialog";
import { CopyField } from "@/features/room/components/copy-field";
import {
  partnerPreferences,
  roomInvitePath,
  type LanguagePreferences,
} from "@/features/room/utils/language-preference";
import { languageLabel } from "@/features/translation/data/languages";

export interface InviteDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly code: string;
  /** Your own preferences; the invite carries your partner's mirror image. */
  readonly preferences: LanguagePreferences;
}

/** Invite sheet: the code to read aloud and the link to paste anywhere. */
export function InviteDialog({
  open,
  onClose,
  code,
  preferences,
}: InviteDialogProps) {
  /*
   * Computed during render, never in an effect: the dialog only opens from a
   * user action, so `window` is guaranteed to exist by then and no server
   * render can produce a mismatched URL.
   */
  const inviteUrl =
    open && typeof window !== "undefined"
      ? `${window.location.origin}${roomInvitePath(code, preferences)}`
      : "";
  const partner = partnerPreferences(preferences);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Invite your partner"
      description={`You speak ${languageLabel(preferences.speaking)} and want to hear ${languageLabel(preferences.listening)}. Your partner speaks ${languageLabel(partner.speaking)} and hears you in ${languageLabel(partner.listening)}.`}
    >
      <div className="space-y-3">
        <CopyField label="Room code" value={code} display={code} />
        <CopyField
          label="Invite link"
          value={inviteUrl}
          display={inviteUrl || "Preparing link…"}
        />
        <p className="text-mute text-xs">
          The link carries your partner&apos;s languages, so they land in the
          right ones. Anyone with this code joins the same two-person room —
          codes ignore case and leave out look-alike characters.
        </p>
      </div>
    </Dialog>
  );
}
