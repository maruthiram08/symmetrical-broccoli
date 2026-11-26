// Jira Cloud REST API v3 (https://developer.atlassian.com/cloud/jira/platform/rest/v3/).
// Auth: Basic base64(email:api_token), with a token from id.atlassian.com/manage-profile/security/api-tokens.
import type { JiraConfig } from "../config";
import { requestJson, type Fetch } from "../http";
import { guessAssignee, type Provider, type TicketInput } from "../provider";

export function jiraSite(site: string): string {
  const s = site.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(s) ? s : `https://${s}`;
}

const headers = (cfg: JiraConfig, token: string) => ({ Authorization: `Basic ${Buffer.from(`${cfg.email}:${token}`).toString("base64")}` });

type Adf = Record<string, unknown>;
const text = (t: string, link?: string): Adf => (link ? { type: "text", text: t, marks: [{ type: "link", attrs: { href: link } }] } : { type: "text", text: t });

/** The description as Atlassian Document Format, which v3 requires. */
export function jiraDescription(t: TicketInput): Adf {
  const content: Adf[] = [];
  if (t.quote) {
    content.push({ type: "blockquote", content: [{ type: "paragraph", content: [text(t.quote), ...(t.speaker ? [{ type: "hardBreak" }, text(`— ${t.speaker}`)] : [])] }] });
  }
  if (t.meetingTitle) {
    content.push({ type: "paragraph", content: [text("From "), { ...text(t.meetingTitle), marks: [{ type: "strong" }] }, text(t.dateLabel ? `, ${t.dateLabel}.` : ".")] });
  } else if (t.dateLabel) content.push({ type: "paragraph", content: [text(`Added ${t.dateLabel}.`)] });
  content.push({ type: "paragraph", content: [text("Open in Daily brief", t.link)] });
  return { type: "doc", version: 1, content };
}

export const jira: Provider<"jira"> = {
  id: "jira",
  label: "Jira",

  incomplete: (cfg) => (!cfg.site ? "Add your Jira site." : !cfg.email ? "Add the email of your Atlassian account." : !cfg.projectKey ? "Add a project key." : null),

  async verify(cfg, token, fetch) {
    const me = await requestJson<{ displayName?: string }>(fetch, `${jiraSite(cfg.site)}/rest/api/3/myself`, { headers: headers(cfg, token) });
    await requestJson(fetch, `${jiraSite(cfg.site)}/rest/api/3/project/${encodeURIComponent(cfg.projectKey)}`, { headers: headers(cfg, token) });
    return { message: `Connected as ${me.displayName ?? cfg.email} · project ${cfg.projectKey}` };
  },

  async create(cfg, token, t, fetch) {
    const site = jiraSite(cfg.site);
    let assignee: { accountId: string; displayName: string } | null = null;
    if (t.assigneeName) {
      try {
        const q = new URLSearchParams({ project: cfg.projectKey, query: t.assigneeName, maxResults: "20" });
        const users = await requestJson<Array<{ accountId: string; displayName: string }>>(fetch, `${site}/rest/api/3/user/assignable/search?${q}`, { headers: headers(cfg, token) });
        const hit = guessAssignee(t.assigneeName, users.map((u) => ({ ...u, id: u.accountId, names: [u.displayName] })));
        assignee = hit ? { accountId: hit.accountId, displayName: hit.displayName } : null;
      } catch {
        assignee = null; // an assignee is a nice-to-have; the ticket still goes in
      }
    }
    const fields: Record<string, unknown> = {
      project: { key: cfg.projectKey },
      summary: t.title.slice(0, 250),
      issuetype: { name: cfg.issueType || "Task" },
      description: jiraDescription(t),
    };
    if (assignee) fields.assignee = { accountId: assignee.accountId };
    if (t.dueDate) fields.duedate = t.dueDate;
    const created = await createWithFallback(fetch, site, cfg, token, fields);
    return { id: created.id, key: created.key, url: `${site}/browse/${created.key}`, assignee: assignee?.displayName ?? null };
  },

  async state(cfg, token, ticket, fetch) {
    try {
      const r = await requestJson<{ fields?: { status?: { statusCategory?: { key?: string } } } }>(
        fetch, `${jiraSite(cfg.site)}/rest/api/3/issue/${encodeURIComponent(ticket.key)}?fields=status`, { headers: headers(cfg, token) });
      return r.fields?.status?.statusCategory?.key === "done" ? "closed" : "open";
    } catch (e) {
      if ((e as { status?: number }).status === 404) return "missing";
      throw e;
    }
  },
};

/** A project whose screen has no due date field rejects `duedate`: try once more without it. */
async function createWithFallback(fetch: Fetch, site: string, cfg: JiraConfig, token: string, fields: Record<string, unknown>) {
  const post = (f: Record<string, unknown>) =>
    requestJson<{ id: string; key: string }>(fetch, `${site}/rest/api/3/issue`, { method: "POST", headers: headers(cfg, token), json: { fields: f } });
  try {
    return await post(fields);
  } catch (e) {
    if ((e as { status?: number }).status !== 400 || !("duedate" in fields || "assignee" in fields)) throw e;
    const { duedate: _d, assignee: _a, ...rest } = fields;
    void _d; void _a;
    return post(rest);
  }
}
