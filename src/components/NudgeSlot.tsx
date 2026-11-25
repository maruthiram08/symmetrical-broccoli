// Server half of a nudge: shows the cached draft (made once a day by the scheduler) on a
// "Waiting on" item that is 3+ days overdue. Never drafts on page load.
import { cache } from "react";
import type { BriefLine } from "@/lib/types";
import { getAiStore } from "@/server/local/ai-store";
import { NudgeCard } from "./NudgeCard";

const nudges = cache(() => new Map(getAiStore().nudges().map((n) => [n.itemId, n])));

export function NudgeSlot({ line }: { line: BriefLine }) {
  if (line.kind !== "waiting" || line.lateMinutes === null) return null;
  const n = nudges().get(line.itemId);
  if (!n) return null;
  return <NudgeCard itemId={line.itemId} person={line.person} text={n.text} />;
}
