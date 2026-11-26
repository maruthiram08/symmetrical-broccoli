// Notion REST API (https://developers.notion.com/reference). Auth: an internal integration token
// (notion.so/profile/integrations) as a Bearer token, and the database shared with that integration.
import { requestJson, type Fetch } from "../http";
import { guessAssignee, type Provider, type TicketInput } from "../provider";

export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2022-06-28";

const headers = (token: string) => ({ Authorization: `Bearer ${token}`, "Notion-Version": NOTION_VERSION });

/** A database id from an id or a notion.so URL ("…/Tasks-1a2b…?v=…"), dashed form. */
export function notionId(input: string): string {
  const hex = /([0-9a-f]{32})(?:[?#/]|$)/i.exec(input.replace(/-/g, ""))?.[1] ?? input.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/i.test(hex)) return input.trim();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toLowerCase();
}

type Prop = { type: string; [k: string]: unknown };
type Rich = { type: "text"; text: { content: string; link?: { url: string } | null }; annotations?: Record<string, boolean> };
const rt = (content: string, opts: { link?: string; bold?: boolean } = {}): Rich => ({
  type: "text",
  text: { content: content.slice(0, 2000), ...(opts.link ? { link: { url: opts.link } } : {}) },
  ...(opts.bold ? { annotations: { bold: true } } : {}),
});

export function notionBlocks(t: TicketInput): unknown[] {
  const blocks: unknown[] = [];
  if (t.quote) blocks.push({ object: "block", type: "quote", quote: { rich_text: [rt(t.quote), ...(t.speaker ? [rt(`\n— ${t.speaker}`)] : [])] } });
  if (t.meetingTitle) {
    blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [rt("From "), rt(t.meetingTitle, { bold: true }), rt(t.dateLabel ? `, ${t.dateLabel}.` : ".")] } });
  } else if (t.dateLabel) blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [rt(`Added ${t.dateLabel}.`)] } });
  blocks.push({ object: "block", type: "paragraph", paragraph: { rich_text: [rt("Open in Daily brief", { link: t.link })] } });
  return blocks;
}

const DONE = /^(done|complete|completed|closed|resolved|shipped)$/i;

/** A page counts as closed when a status or select says Done, or a "Done"/"Complete" checkbox is ticked. */
export function notionPageClosed(props: Record<string, Prop>): boolean {
  for (const [name, p] of Object.entries(props)) {
    if (p.type === "status" && DONE.test((p.status as { name?: string } | null)?.name ?? "")) return true;
    if (p.type === "select" && /status/i.test(name) && DONE.test((p.select as { name?: string } | null)?.name ?? "")) return true;
    if (p.type === "checkbox" && /done|complete/i.test(name) && p.checkbox === true) return true;
  }
  return false;
}

async function users(fetch: Fetch, token: string) {
  const r = await requestJson<{ results: Array<{ id: string; name?: string | null; type: string }> }>(fetch, `${NOTION_API}/users?page_size=100`, { headers: headers(token) });
  return r.results.filter((u) => u.type === "person" && u.name).map((u) => ({ id: u.id, names: [u.name as string] }));
}

export const notion: Provider<"notion"> = {
  id: "notion",
  label: "Notion",

  incomplete: (cfg) => (!cfg.databaseId ? "Add the database to put tickets in." : null),

  async verify(cfg, token, fetch) {
    const db = await requestJson<{ title?: Array<{ plain_text?: string }>; properties: Record<string, Prop> }>(
      fetch, `${NOTION_API}/databases/${encodeURIComponent(notionId(cfg.databaseId))}`, { headers: headers(token) });
    const props = Object.entries(db.properties ?? {});
    const title = props.find(([, p]) => p.type === "title")?.[0] ?? null;
    if (!title) throw new Error("That database has no title column.");
    const people = props.find(([, p]) => p.type === "people")?.[0] ?? null;
    const name = db.title?.map((x) => x.plain_text ?? "").join("") || "your database";
    return { message: `Connected · ${name}`, patch: { databaseId: notionId(cfg.databaseId), titleProperty: title, peopleProperty: people } };
  },

  async create(cfg, token, t, fetch) {
    const properties: Record<string, unknown> = { [cfg.titleProperty ?? "Name"]: { title: [rt(t.title)] } };
    let assignee: string | null = null;
    if (cfg.peopleProperty && t.assigneeName) {
      try {
        const hit = guessAssignee(t.assigneeName, await users(fetch, token));
        if (hit) { properties[cfg.peopleProperty] = { people: [{ id: hit.id }] }; assignee = hit.names[0]; }
      } catch {
        assignee = null;
      }
    }
    const page = await requestJson<{ id: string; url: string }>(fetch, `${NOTION_API}/pages`, {
      method: "POST",
      headers: headers(token),
      json: { parent: { database_id: notionId(cfg.databaseId) }, properties, children: notionBlocks(t) },
    });
    return { id: page.id, key: "Notion", url: page.url, assignee };
  },

  async state(_cfg, token, ticket, fetch) {
    try {
      const p = await requestJson<{ archived?: boolean; in_trash?: boolean; properties?: Record<string, Prop> }>(
        fetch, `${NOTION_API}/pages/${encodeURIComponent(ticket.id)}`, { headers: headers(token) });
      if (p.archived || p.in_trash) return "missing";
      return notionPageClosed(p.properties ?? {}) ? "closed" : "open";
    } catch (e) {
      if ((e as { status?: number }).status === 404) return "missing";
      throw e;
    }
  },
};
