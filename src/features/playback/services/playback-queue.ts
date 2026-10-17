/**
 * Ordered, duplicate-free playback queue for one listener (Stage 6).
 *
 * The server delivers each utterance's audio at most once, but delivery
 * order is only as reliable as the transport, and a reconnect/history replay
 * must never replay audio. This queue therefore:
 *
 * - drops any item whose utterance id was already queued or played,
 * - drops any item whose `sequence` is not newer than the last played one
 *   (a late arrival for a message the listener already moved past),
 * - hands items out in per-room `sequence` order,
 * - bounds its own memory (oldest overflow is dropped and marked played so
 *   a late duplicate can still not resurrect it).
 *
 * Stage 7 hooks: `interrupt(boundary)` drops the interrupted turn (everything
 * at or below the server's interruption sequence) while keeping genuinely new
 * speech, and `reset()` forgets everything for a room change or teardown.
 * `clear()` discards everything queued but keeps the watermark; `markPlayed`
 * advances the watermark. An interruption is therefore one `interrupt` call
 * plus the caller's `AudioPlayer.stop()`.
 */

/** One playable audio delivery, already validated by the socket listener. */
export interface PlaybackItem {
  readonly utteranceId: string;
  /** Per-room, server-assigned ordering counter (1-based, monotonic). */
  readonly sequence: number;
  readonly language: string;
  readonly mimeType: string;
  readonly audio: ArrayBuffer;
}

export interface PlaybackQueueOptions {
  /** Maximum simultaneously queued items; the oldest overflow is dropped. */
  readonly capacity?: number;
}

/** Backlog above which the room has visibly moved on (and audio is dropped). */
export const DEFAULT_PLAYBACK_CAPACITY = 8;

export class PlaybackQueue {
  private readonly capacity: number;
  private items: PlaybackItem[] = [];
  private readonly seenIds = new Set<string>();
  private lastPlayedSequence = 0;

  constructor(options: PlaybackQueueOptions = {}) {
    this.capacity =
      typeof options.capacity === "number" && options.capacity > 0
        ? Math.floor(options.capacity)
        : DEFAULT_PLAYBACK_CAPACITY;
  }

  /** Number of items waiting to play (excludes the active one). */
  get size(): number {
    return this.items.length;
  }

  /**
   * Newest `sequence` accepted so far (0 before anything played). Interruptions
   * raise this watermark too, so the value is really "everything at or below
   * here is closed", not only "played".
   */
  get playedUpTo(): number {
    return this.lastPlayedSequence;
  }

  /**
   * Enqueue one delivery. Returns `false` when the item was discarded as a
   * duplicate, a stale late arrival, or overflow.
   */
  enqueue(item: PlaybackItem): boolean {
    if (item.sequence <= this.lastPlayedSequence) return false;
    if (this.seenIds.has(item.utteranceId)) return false;
    // Insert in sequence order so a shuffled delivery still plays in order.
    const index = this.items.findIndex((queued) => queued.sequence > item.sequence);
    if (index === -1) this.items.push(item);
    else this.items.splice(index, 0, item);
    this.seenIds.add(item.utteranceId);
    while (this.items.length > this.capacity) {
      this.items.shift();
    }
    return true;
  }

  /** The next item to play, or `null` when the queue is empty. */
  next(): PlaybackItem | null {
    return this.items[0] ?? null;
  }

  /**
   * Record that an item finished playing: subsequent arrivals for older
   * sequences are stale and older duplicates stay dead.
   */
  markPlayed(item: Pick<PlaybackItem, "utteranceId" | "sequence">): void {
    this.seenIds.add(item.utteranceId);
    this.lastPlayedSequence = Math.max(this.lastPlayedSequence, item.sequence);
    this.items = this.items.filter(
      (queued) => queued.utteranceId !== item.utteranceId,
    );
  }

  /** Drop every queued item (manual cancel); keeps the played watermark. */
  clear(): void {
    this.items = [];
  }

  /**
   * Interruption boundary (Stage 7): everything at or below `sequence` belongs
   * to the interrupted turn. Queued items in that range are discarded and the
   * watermark advances to the boundary, so a late TTS frame or audio blob for
   * the old turn can never be enqueued again. Items above the boundary are new
   * speech and are deliberately kept. Returns how many queued items were
   * dropped.
   */
  interrupt(sequence: number): number {
    if (!Number.isFinite(sequence)) return 0;
    const boundary = Math.max(0, Math.floor(sequence));
    if (boundary <= this.lastPlayedSequence) return 0;
    const before = this.items.length;
    this.items = this.items.filter((item) => item.sequence > boundary);
    this.lastPlayedSequence = boundary;
    return before - this.items.length;
  }

  /**
   * Forget everything: queued items, seen ids, and the watermark. Used when the
   * listening context itself changes (room change or teardown), where the
   * server's sequence counter restarts and old watermarks would wrongly reject
   * the new room's first utterance.
   */
  reset(): void {
    this.items = [];
    this.seenIds.clear();
    this.lastPlayedSequence = 0;
  }
}
