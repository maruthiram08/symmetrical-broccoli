import { formatTime, localDate } from "@/lib/brief/time";
import { CHANNEL_IDS, CHANNEL_LABEL, type ChannelId, type ChannelsFile } from "./config";

export interface ChannelHealth {
  id: ChannelId;
  label: string;
  /** "ok": last attempt worked. "failed": the last attempt failed. "never": on, nothing sent yet. */
  state: "ok" | "failed" | "never";
  line: string;
}

/** One line per channel that is on, for Settings › Health. Pure. */
export function channelHealth(file: ChannelsFile, timeZone: string, now: Date): ChannelHealth[] {
  const today = localDate(now, timeZone);
  const at = (iso: string) => `${localDate(new Date(iso), timeZone) === today ? "today" : localDate(new Date(iso), timeZone)}, ${formatTime(iso, timeZone)}`;
  return CHANNEL_IDS.filter((id) => file[id].enabled).map((id) => {
    const s = file.status[id];
    const label = CHANNEL_LABEL[id];
    const failedLast = !!s?.lastErrorAt && (!s.lastOkAt || s.lastErrorAt > s.lastOkAt);
    if (failedLast) return { id, label, state: "failed" as const, line: `failed ${at(s!.lastErrorAt!)}: ${s!.lastError ?? "error"}` };
    if (s?.lastOkAt) return { id, label, state: "ok" as const, line: `sent ${at(s.lastOkAt)}` };
    return { id, label, state: "never" as const, line: "on, nothing sent yet" };
  });
}
