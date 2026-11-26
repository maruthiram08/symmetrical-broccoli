// Todoist API v1 (https://developer.todoist.com/api/v1/), which replaced REST v2. Auth: the API token
// from Todoist Settings › Integrations › Developer, as a Bearer token.
import { requestJson, type Fetch } from "../http";
import { guessAssignee, markdownDescription, type Provider } from "../provider";

export const TODOIST_API = "https://api.todoist.com/api/v1";

const headers = (token: string) => ({ Authorization: `Bearer ${token}` });
export const todoistTaskUrl = (id: string) => `https://app.todoist.com/app/task/${encodeURIComponent(id)}`;

async function collaborators(fetch: Fetch, token: string, projectId: string) {
  const r = await requestJson<{ results?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>>(
    fetch, `${TODOIST_API}/projects/${encodeURIComponent(projectId)}/collaborators`, { headers: headers(token) });
  return (Array.isArray(r) ? r : r.results ?? []).map((u) => ({ id: String(u.id), names: [u.name] }));
}

export const todoist: Provider<"todoist"> = {
  id: "todoist",
  label: "Todoist",

  incomplete: () => null,

  async verify(cfg, token, fetch) {
    if (cfg.projectId) {
      const p = await requestJson<{ name?: string }>(fetch, `${TODOIST_API}/projects/${encodeURIComponent(cfg.projectId)}`, { headers: headers(token) });
      return { message: `Connected · project ${p.name ?? cfg.projectId}` };
    }
    await requestJson(fetch, `${TODOIST_API}/projects?limit=1`, { headers: headers(token) });
    return { message: "Connected · tasks go to your Inbox" };
  },

  async create(cfg, token, t, fetch) {
    const body: Record<string, unknown> = { content: t.title, description: markdownDescription(t) };
    if (cfg.projectId) body.project_id = cfg.projectId;
    if (t.dueDate) body.due_date = t.dueDate;
    let assignee: string | null = null;
    // Assignees exist only in shared projects, so only try with a project set.
    if (cfg.projectId && t.assigneeName) {
      try {
        const hit = guessAssignee(t.assigneeName, await collaborators(fetch, token, cfg.projectId));
        if (hit) { body.assignee_id = hit.id; assignee = hit.names[0]; }
      } catch {
        assignee = null;
      }
    }
    const task = await requestJson<{ id: string | number; url?: string }>(fetch, `${TODOIST_API}/tasks`, { method: "POST", headers: headers(token), json: body });
    const id = String(task.id);
    return { id, key: "Todoist", url: task.url ?? todoistTaskUrl(id), assignee };
  },

  async state(_cfg, token, ticket, fetch) {
    try {
      const task = await requestJson<{ checked?: boolean; is_completed?: boolean; completed_at?: string | null; is_deleted?: boolean }>(
        fetch, `${TODOIST_API}/tasks/${encodeURIComponent(ticket.id)}`, { headers: headers(token) });
      if (task.is_deleted) return "missing";
      return task.checked || task.is_completed || task.completed_at ? "closed" : "open";
    } catch (e) {
      // A deleted task is a 404; so is a completed one on some accounts. Don't guess: leave the item open.
      if ((e as { status?: number }).status === 404) return "missing";
      throw e;
    }
  },
};
