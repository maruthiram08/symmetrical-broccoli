// Server half of "Send to …": reads the item's ticket and which services are on, once per request.
import { cache } from "react";
import type { ItemTicket } from "@/lib/types";
import { getIntegrations } from "@/server/integrations/config";
import { PROVIDERS, enabledProviders } from "@/server/integrations/tickets";
import { getStore, me } from "@/server/local/app";
import { SendToMenu, SendToRow } from "./SendToMenu";

const tickets = cache(async (): Promise<Map<string, ItemTicket>> => {
  const user = await me();
  if (!user) return new Map();
  return new Map((await getStore().listItems(user.id)).flatMap((i) => (i.ticket ? [[i.id, i.ticket] as const] : [])));
});
const providers = cache(async () => enabledProviders(getIntegrations()));

/** "Ticket: LIN-123", linked, in the item's meta line. */
export async function TicketLabel({ itemId, lead = "· " }: { itemId: string; lead?: string }) {
  const t = (await tickets()).get(itemId);
  if (!t) return null;
  return (
    <a className="db-item__src int-ticket" href={t.url} target="_blank" rel="noopener noreferrer" title={`Open in ${PROVIDERS[t.provider].label}`}>
      {lead}Ticket: <span className="int-ticket__key">{t.key}</span>
    </a>
  );
}

/** "Send to …" for an item without a ticket, when at least one service is on. */
export async function TicketSend({ itemId, variant = "menu" }: { itemId: string; variant?: "menu" | "row" }) {
  if ((await tickets()).has(itemId)) return null;
  const ps = await providers();
  if (!ps.length) return null;
  return variant === "row" ? <SendToRow itemId={itemId} providers={ps} /> : <SendToMenu itemId={itemId} providers={ps} />;
}
