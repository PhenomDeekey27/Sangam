import { ROOM_ROUTE_PREFIX } from "@/lib/constants";
import type { RoomCode } from "../types";

/** Build the canonical URL for a room screen. */
export function roomPath(code: RoomCode): string {
  return `${ROOM_ROUTE_PREFIX}/${encodeURIComponent(code)}`;
}
