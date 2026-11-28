// Server half of "Start this": reads when each item was last started, once per request.
import { cache } from "react";
import type { BriefLine } from "@/lib/types";
import { startedLabels } from "@/server/handoff";
import { HandoffPanel } from "./StartThis";
import { TicketSend } from "./integrations/TicketSlot";

const labels = cache(startedLabels);

export async function HandoffSlot({ line }: { line: BriefLine }) {
  if (line.kind === "decision") return null;
  const started = (await labels()).get(line.itemId) ?? null;
  return <HandoffPanel itemId={line.itemId} kind={line.kind} person={line.person} started={started} extra={<TicketSend itemId={line.itemId} variant="row" />} />;
}
