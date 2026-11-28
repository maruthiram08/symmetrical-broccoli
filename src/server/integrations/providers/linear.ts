// Linear's public API (https://linear.app/developers/graphql). Linear has no REST API: its official
// API is GraphQL over HTTPS POST to https://api.linear.app/graphql. Auth: a personal API key from
// Settings › Security & access, sent as the Authorization header (no "Bearer" for personal keys).
import { HttpError, requestJson, type Fetch } from "../http";
import { guessAssignee, markdownDescription, type Provider } from "../provider";

export const LINEAR_URL = "https://api.linear.app/graphql";

async function gql<T>(fetch: Fetch, token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const r = await requestJson<{ data?: T; errors?: Array<{ message: string; extensions?: { code?: string } }> }>(fetch, LINEAR_URL, {
    method: "POST",
    headers: { Authorization: token },
    json: { query, variables },
  });
  if (r.errors?.length) {
    const code = r.errors[0].extensions?.code;
    throw new HttpError(code === "AUTHENTICATION_ERROR" ? 401 : code === "RATELIMITED" ? 429 : 400, r.errors[0].message.slice(0, 160));
  }
  return r.data as T;
}

export const linear: Provider<"linear"> = {
  id: "linear",
  label: "Linear",

  incomplete: (cfg) => (!cfg.teamKey ? "Add a team key, like ENG." : null),

  async verify(cfg, token, fetch) {
    const d = await gql<{ viewer: { name: string }; teams: { nodes: Array<{ id: string; key: string; name: string }> } }>(
      fetch, token, "query DailyBriefVerify { viewer { id name } teams(first: 250) { nodes { id key name } } }");
    const team = d.teams.nodes.find((t) => t.key.toLowerCase() === cfg.teamKey.trim().toLowerCase());
    if (!team) throw new Error(`No team with key ${cfg.teamKey} (you have ${d.teams.nodes.map((t) => t.key).join(", ") || "none"}).`);
    return { message: `Connected as ${d.viewer.name} · team ${team.name}`, patch: { teamId: team.id, teamKey: team.key } };
  },

  async create(cfg, token, t, fetch) {
    if (!cfg.teamId) throw new Error("Save Linear settings again to look up the team.");
    let assignee: { id: string; name: string } | null = null;
    if (t.assigneeName) {
      try {
        const d = await gql<{ users: { nodes: Array<{ id: string; name: string; displayName: string }> } }>(
          fetch, token, "query DailyBriefUsers { users(first: 250, filter: { active: { eq: true } }) { nodes { id name displayName } } }");
        const hit = guessAssignee(t.assigneeName, d.users.nodes.map((u) => ({ ...u, names: [u.name, u.displayName] })));
        assignee = hit ? { id: hit.id, name: hit.name } : null;
      } catch {
        assignee = null;
      }
    }
    const input: Record<string, unknown> = { teamId: cfg.teamId, title: t.title, description: markdownDescription(t) };
    if (assignee) input.assigneeId = assignee.id;
    if (t.dueDate) input.dueDate = t.dueDate;
    const d = await gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; url: string } | null } }>(
      fetch, token,
      "mutation DailyBriefCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier url } } }",
      { input });
    if (!d.issueCreate.success || !d.issueCreate.issue) throw new Error("Linear didn't create the issue.");
    const i = d.issueCreate.issue;
    return { id: i.id, key: i.identifier, url: i.url, assignee: assignee?.name ?? null };
  },

  async state(_cfg, token, ticket, fetch) {
    try {
      const d = await gql<{ issue: { state: { type: string } } | null }>(
        fetch, token, "query DailyBriefState($id: String!) { issue(id: $id) { id state { type } } }", { id: ticket.id });
      if (!d.issue) return "missing";
      return d.issue.state.type === "completed" || d.issue.state.type === "canceled" ? "closed" : "open";
    } catch (e) {
      if (e instanceof HttpError && e.status === 400 && /not found|entity/i.test(e.message)) return "missing";
      throw e;
    }
  },
};
