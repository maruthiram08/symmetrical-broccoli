// Server half of a nudge: shows the cached draft (made once a day by the scheduler) on a
// "Waiting on" item that is 3+ days overdue. Never drafts on page load.
import { cache } from "react";
import type { BriefLine } from "@/lib/types";
import { currentAi } from "@/server/ai-state";
import { NudgeCard } from "./NudgeCard";
import { channelConfig } from "@/server/channels/local";
import { nudgesReady } from "@/server/channels/nudge";

const slackReady = cache(() => nudgesReady(channelConfig().read()));
const nudges = cache(async () => new Map((await currentAi()).ai.nudges().map((n) => [n.itemId, n])));

export async function NudgeSlot({ line }: { line: BriefLine }) {
  if (line.kind !== "waiting" || line.lateMinutes === null) return null;
  const n = (await nudges()).get(line.itemId);
  if (!n) return null;
  return <NudgeCard itemId={line.itemId} person={line.person} text={n.text} slack={slackReady()} />;
}
