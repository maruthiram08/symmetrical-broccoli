// What runs after a meeting's items are committed: today only Cross-check with Wispr Flow, which
// is off by default and local only (src/server/crosscheck). Loaded lazily, wrapped so nothing it
// does can fail or slow down a read's result.
import type { WisprClient } from "@/server/wispr/client";

export interface AfterExtract {
  store: unknown;
  wispr: (userId: string) => WisprClient;
  meetingId: string;
  /** The run's open Wispr Flow connection, when there is one. */
  client?: WisprClient;
  dropped?: Array<{ reason: string; text: string }>;
  now: () => Date;
}

type Hook = (ev: AfterExtract) => Promise<void>;
const g = globalThis as unknown as { __dbAfterExtract?: Hook | null };

/** Tests: replace the hook (null turns it off). undefined restores the default. */
export function setAfterExtract(h: Hook | null | undefined): void { g.__dbAfterExtract = h; }

/** Never throws. */
export async function afterExtract(ev: AfterExtract): Promise<void> {
  try {
    const hook = g.__dbAfterExtract !== undefined ? g.__dbAfterExtract : (await import("@/server/crosscheck/core")).crosscheckAfterExtraction;
    if (hook) await hook(ev);
  } catch (e) {
    console.error(`[after-extract] ${e instanceof Error ? e.name : "Error"}`);
  }
}
