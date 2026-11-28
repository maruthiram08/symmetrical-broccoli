// Item -> ticket and the two-way close, against mocked HTTP shaped like each service's official docs.
import { describe, expect, it } from "vitest";
import { guessAssignee, markdownDescription } from "./provider";
import { jira, jiraDescription } from "./providers/jira";
import { LINEAR_URL, linear } from "./providers/linear";
import { NOTION_API, NOTION_VERSION, notion, notionId, notionPageClosed } from "./providers/notion";
import { TODOIST_API, todoist } from "./providers/todoist";
import { disconnectProvider, enabledProviders, saveProvider, sendToTicket, syncTickets, TICKET_SYNC_EVERY_MS, ticketInput, type TicketDeps } from "./tickets";
import { memVault, mockFetch, NOW, seeded, tmpIntegrations, type Handler } from "./test-helpers";

const APP = "http://localhost:4242";

describe("guessAssignee", () => {
  const users = [
    { id: "1", names: ["Nitin Kumar"] },
    { id: "2", names: ["Nisha Rao"] },
    { id: "3", names: ["Tarun S", "tarun"] },
    { id: "4", names: ["Amit Shah"] },
    { id: "5", names: ["Amit Verma"] },
  ];
  it("matches a full name, a first name, and an initial", () => {
    expect(guessAssignee("Nitin Kumar", users)?.id).toBe("1");
    expect(guessAssignee("nitin", users)?.id).toBe("1");
    expect(guessAssignee("Nitin K", users)?.id).toBe("1");
    expect(guessAssignee("Tarun", users)?.id).toBe("3");
  });
  it("leaves it unassigned when unsure", () => {
    expect(guessAssignee("Amit", users)).toBeNull();
    expect(guessAssignee("Ni", users)).toBeNull(); // first word must be whole
    expect(guessAssignee("Priya", users)).toBeNull();
    expect(guessAssignee(null, users)).toBeNull();
  });
});

describe("ticketInput", () => {
  it("has the title, quote, meeting, date, a link back and who to assign", async () => {
    const { user, meeting, owe, waiting } = await seeded();
    const t = ticketInput(waiting, meeting, user, APP);
    expect(t).toMatchObject({
      title: "Nitin to share the API spec",
      quote: "Main spec bhej dunga kal tak",
      speaker: "Nitin",
      meetingTitle: "Banner sync",
      dateLabel: "Tue, 24 Nov 2026",
      link: `${APP}/item/${encodeURIComponent(waiting.id)}`,
      assigneeName: "Nitin",
      dueDate: null,
    });
    const o = ticketInput(owe, meeting, user, APP);
    expect(o.assigneeName).toBe("Maruthi R"); // you owe it: it's yours
    expect(o.dueDate).toBe("2026-11-27");
    const md = markdownDescription(o);
    expect(md).toContain("> I'll send you the final text by Friday");
    expect(md).toContain("From **Banner sync**, Tue, 24 Nov 2026.");
    expect(md).toContain(`[Open in Daily brief](${APP}/item/`);
  });
});

// ---------- per-provider request shapes ----------

const input = { title: "Nitin to share the API spec", quote: "Main spec bhej dunga", speaker: "Nitin", meetingTitle: "Banner sync", dateLabel: "Tue, 24 Nov 2026", link: `${APP}/item/i1`, assigneeName: "Nitin", dueDate: "2026-11-27" };

describe("Jira (REST v3)", () => {
  const cfg = { enabled: true, site: "https://acme.atlassian.net", email: "me@acme.com", projectKey: "OPS", issueType: "Task" };
  it("creates an issue with ADF description, assignee by accountId and due date", async () => {
    const f = mockFetch(
      (c) => (c.url.includes("/rest/api/3/user/assignable/search") ? { json: [{ accountId: "acc-1", displayName: "Nitin Kumar" }, { accountId: "acc-2", displayName: "Priya Shah" }] } : undefined),
      (c) => (c.url.endsWith("/rest/api/3/issue") && c.method === "POST" ? { status: 201, json: { id: "10001", key: "OPS-7", self: "https://acme.atlassian.net/rest/api/3/issue/10001" } } : undefined),
    );
    const r = await jira.create(cfg, "tok-123", input, f);
    expect(r).toEqual({ id: "10001", key: "OPS-7", url: "https://acme.atlassian.net/browse/OPS-7", assignee: "Nitin Kumar" });
    const search = f.calls[0];
    expect(search.url).toBe("https://acme.atlassian.net/rest/api/3/user/assignable/search?project=OPS&query=Nitin&maxResults=20");
    expect(search.headers.authorization).toBe(`Basic ${Buffer.from("me@acme.com:tok-123").toString("base64")}`);
    const post = f.calls[1];
    expect(post.headers["content-type"]).toBe("application/json");
    expect(post.body).toEqual({
      fields: {
        project: { key: "OPS" },
        summary: input.title,
        issuetype: { name: "Task" },
        description: jiraDescription(input),
        assignee: { accountId: "acc-1" },
        duedate: "2026-11-27",
      },
    });
    const adf = jiraDescription(input) as { type: string; version: number; content: Array<{ type: string }> };
    expect(adf.type).toBe("doc");
    expect(adf.version).toBe(1);
    expect(adf.content.map((b) => b.type)).toEqual(["blockquote", "paragraph", "paragraph"]);
    expect(JSON.stringify(adf)).toContain(`"href":"${APP}/item/i1"`);
  });
  it("tries again without due date and assignee when the screen rejects them", async () => {
    let n = 0;
    const f = mockFetch(
      (c) => (c.url.includes("assignable") ? { json: [{ accountId: "acc-1", displayName: "Nitin" }] } : undefined),
      (c) => (c.method === "POST" ? (++n === 1 ? { status: 400, json: { errors: { duedate: "Field 'duedate' cannot be set." } } } : { status: 201, json: { id: "1", key: "OPS-8" } }) : undefined),
    );
    const r = await jira.create(cfg, "t", input, f);
    expect(r.key).toBe("OPS-8");
    const fields = (f.calls.at(-1)!.body as { fields: Record<string, unknown> }).fields;
    expect(fields.duedate).toBeUndefined();
    expect(fields.assignee).toBeUndefined();
  });
  it("reads done from the status category", async () => {
    const at = (key: string): Handler => () => ({ json: { fields: { status: { name: "Shipped", statusCategory: { key } } } } });
    expect(await jira.state(cfg, "t", { id: "1", key: "OPS-7" }, mockFetch(at("done")))).toBe("closed");
    expect(await jira.state(cfg, "t", { id: "1", key: "OPS-7" }, mockFetch(at("indeterminate")))).toBe("open");
    expect(await jira.state(cfg, "t", { id: "1", key: "OPS-7" }, mockFetch(() => ({ status: 404, json: { errorMessages: ["Issue does not exist"] } })))).toBe("missing");
    const f = mockFetch(at("done"));
    await jira.state(cfg, "t", { id: "1", key: "OPS-7" }, f);
    expect(f.calls[0].url).toBe("https://acme.atlassian.net/rest/api/3/issue/OPS-7?fields=status");
  });
});

describe("Linear (GraphQL API)", () => {
  const cfg = { enabled: true, teamKey: "ENG", teamId: "team-1" };
  it("creates an issue with issueCreate, the API key as Authorization, assignee matched by name", async () => {
    const f = mockFetch(
      (c) => ((c.body as { query: string }).query.includes("users(") ? { json: { data: { users: { nodes: [{ id: "u1", name: "Nitin Kumar", displayName: "nitin" }, { id: "u2", name: "Maruthi R", displayName: "maru" }] } } } } : undefined),
      (c) => ((c.body as { query: string }).query.includes("issueCreate") ? { json: { data: { issueCreate: { success: true, issue: { id: "iss-1", identifier: "ENG-123", url: "https://linear.app/acme/issue/ENG-123/x" } } } } } : undefined),
    );
    const r = await linear.create(cfg, "lin_api_abc", input, f);
    expect(r).toEqual({ id: "iss-1", key: "ENG-123", url: "https://linear.app/acme/issue/ENG-123/x", assignee: "Nitin Kumar" });
    for (const c of f.calls) {
      expect(c.url).toBe(LINEAR_URL);
      expect(c.method).toBe("POST");
      expect(c.headers.authorization).toBe("lin_api_abc");
    }
    const create = f.calls[1].body as { variables: { input: Record<string, unknown> } };
    expect(create.variables.input).toEqual({ teamId: "team-1", title: input.title, description: markdownDescription(input), assigneeId: "u1", dueDate: "2026-11-27" });
  });
  it("verify finds the team by key and keeps its id", async () => {
    const f = mockFetch(() => ({ json: { data: { viewer: { id: "v", name: "Maruthi R" }, teams: { nodes: [{ id: "t-9", key: "ENG", name: "Engineering" }] } } } }));
    const r = await linear.verify({ enabled: false, teamKey: "eng", teamId: null }, "k", f);
    expect(r).toEqual({ message: "Connected as Maruthi R · team Engineering", patch: { teamId: "t-9", teamKey: "ENG" } });
    await expect(linear.verify({ enabled: false, teamKey: "OPS", teamId: null }, "k", f)).rejects.toThrow(/No team with key OPS/);
  });
  it("closed means completed or canceled", async () => {
    const st = (type: string) => mockFetch(() => ({ json: { data: { issue: { id: "x", state: { type } } } } }));
    expect(await linear.state(cfg, "k", { id: "iss-1", key: "ENG-1" }, st("completed"))).toBe("closed");
    expect(await linear.state(cfg, "k", { id: "iss-1", key: "ENG-1" }, st("canceled"))).toBe("closed");
    expect(await linear.state(cfg, "k", { id: "iss-1", key: "ENG-1" }, st("started"))).toBe("open");
    const bad = mockFetch(() => ({ json: { errors: [{ message: "Authentication required", extensions: { code: "AUTHENTICATION_ERROR" } }] } }));
    await expect(linear.state(cfg, "k", { id: "iss-1", key: "ENG-1" }, bad)).rejects.toMatchObject({ status: 401 });
  });
});

describe("Notion (REST API)", () => {
  const cfg = { enabled: true, databaseId: "1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809", titleProperty: "Task", peopleProperty: "Owner" };
  it("reads a database id from a link", () => {
    expect(notionId("https://www.notion.so/acme/Tasks-1a2b3c4d5e6f708192a3b4c5d6e7f809?v=0f1e2d3c4b5a69788796a5b4c3d2e1f0")).toBe("1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809");
    expect(notionId("1a2b3c4d5e6f708192a3b4c5d6e7f809")).toBe("1a2b3c4d-5e6f-7081-92a3-b4c5d6e7f809");
  });
  it("creates a page in the database with a quote block, Bearer token and Notion-Version", async () => {
    const f = mockFetch(
      (c) => (c.url.startsWith(`${NOTION_API}/users`) ? { json: { object: "list", results: [{ object: "user", id: "nu-1", type: "person", name: "Nitin Kumar" }, { object: "user", id: "bot", type: "bot", name: "Daily brief" }] } } : undefined),
      (c) => (c.url === `${NOTION_API}/pages` ? { json: { object: "page", id: "page-1", url: "https://www.notion.so/Nitin-to-share-page1" } } : undefined),
    );
    const r = await notion.create(cfg, "ntn_secret", input, f);
    expect(r).toEqual({ id: "page-1", key: "Notion", url: "https://www.notion.so/Nitin-to-share-page1", assignee: "Nitin Kumar" });
    const post = f.calls[1];
    expect(post.headers.authorization).toBe("Bearer ntn_secret");
    expect(post.headers["notion-version"]).toBe(NOTION_VERSION);
    const b = post.body as { parent: unknown; properties: Record<string, unknown>; children: Array<{ type: string }> };
    expect(b.parent).toEqual({ database_id: cfg.databaseId });
    expect(b.properties.Task).toEqual({ title: [{ type: "text", text: { content: input.title } }] });
    expect(b.properties.Owner).toEqual({ people: [{ id: "nu-1" }] });
    expect(b.children.map((x) => x.type)).toEqual(["quote", "paragraph", "paragraph"]);
    expect(JSON.stringify(b.children)).toContain(`"link":{"url":"${APP}/item/i1"}`);
  });
  it("verify finds the title and people columns", async () => {
    const f = mockFetch(() => ({ json: { object: "database", title: [{ plain_text: "Tasks" }], properties: { Task: { id: "title", type: "title" }, Owner: { id: "p", type: "people" }, Status: { id: "s", type: "status" } } } }));
    const r = await notion.verify({ ...cfg, titleProperty: null, peopleProperty: null }, "t", f);
    expect(r.patch).toEqual({ databaseId: cfg.databaseId, titleProperty: "Task", peopleProperty: "Owner" });
    expect(f.calls[0].url).toBe(`${NOTION_API}/databases/${cfg.databaseId}`);
  });
  it("closed when Status is Done or a Done checkbox is ticked; archived pages are missing", async () => {
    expect(notionPageClosed({ Status: { type: "status", status: { name: "Done" } } })).toBe(true);
    expect(notionPageClosed({ Status: { type: "status", status: { name: "In progress" } } })).toBe(false);
    expect(notionPageClosed({ Done: { type: "checkbox", checkbox: true } })).toBe(true);
    expect(notionPageClosed({ Status: { type: "select", select: { name: "Complete" } } })).toBe(true);
    expect(await notion.state(cfg, "t", { id: "p", key: "Notion" }, mockFetch(() => ({ json: { archived: true, properties: {} } })))).toBe("missing");
    expect(await notion.state(cfg, "t", { id: "p", key: "Notion" }, mockFetch(() => ({ json: { properties: { Status: { type: "status", status: { name: "Done" } } } } })))).toBe("closed");
  });
});

describe("Todoist (API v1)", () => {
  it("creates a task with description, due date and a collaborator as assignee", async () => {
    const f = mockFetch(
      (c) => (c.url.endsWith("/collaborators") ? { json: { results: [{ id: "77", name: "Nitin Kumar", email: "n@x" }], next_cursor: null } } : undefined),
      (c) => (c.url === `${TODOIST_API}/tasks` ? { json: { id: "6X7rM8997g3RQmvh", content: input.title, checked: false } } : undefined),
    );
    const r = await todoist.create({ enabled: true, projectId: "6Jf8VQXxpwv56VQ7" }, "abc123", input, f);
    expect(r).toEqual({ id: "6X7rM8997g3RQmvh", key: "Todoist", url: "https://app.todoist.com/app/task/6X7rM8997g3RQmvh", assignee: "Nitin Kumar" });
    expect(f.calls[0].url).toBe(`${TODOIST_API}/projects/6Jf8VQXxpwv56VQ7/collaborators`);
    const post = f.calls[1];
    expect(post.headers.authorization).toBe("Bearer abc123");
    expect(post.body).toEqual({ content: input.title, description: markdownDescription(input), project_id: "6Jf8VQXxpwv56VQ7", due_date: "2026-11-27", assignee_id: "77" });
  });
  it("goes to the Inbox with no project, and never asks for collaborators", async () => {
    const f = mockFetch(() => ({ json: { id: "1" } }));
    await todoist.create({ enabled: true, projectId: "" }, "abc", input, f);
    expect(f.calls).toHaveLength(1);
    expect((f.calls[0].body as Record<string, unknown>).project_id).toBeUndefined();
  });
  it("checked tasks are closed; a 404 is missing, not closed", async () => {
    expect(await todoist.state({ enabled: true, projectId: "" }, "t", { id: "1", key: "Todoist" }, mockFetch(() => ({ json: { id: "1", checked: true } })))).toBe("closed");
    expect(await todoist.state({ enabled: true, projectId: "" }, "t", { id: "1", key: "Todoist" }, mockFetch(() => ({ json: { id: "1", checked: false } })))).toBe("open");
    expect(await todoist.state({ enabled: true, projectId: "" }, "t", { id: "1", key: "Todoist" }, mockFetch(() => ({ status: 404, json: {} })))).toBe("missing");
  });
});

// ---------- sending and syncing ----------

const linearCreate: Handler = (c) => ((c.body as { query?: string })?.query?.includes("issueCreate") ? { json: { data: { issueCreate: { success: true, issue: { id: "iss-1", identifier: "LIN-123", url: "https://linear.app/a/issue/LIN-123" } } } } } : undefined);
const linearUsers: Handler = (c) => ((c.body as { query?: string })?.query?.includes("users(") ? { json: { data: { users: { nodes: [{ id: "u1", name: "Nitin Kumar", displayName: "nitin" }] } } } } : undefined);

async function setup(handlers: Handler[] = [linearUsers, linearCreate]) {
  const s = await seeded();
  const integrations = tmpIntegrations();
  integrations.update((st) => { st.providers.linear = { enabled: true, teamKey: "LIN", teamId: "team-1" }; });
  const fetch = mockFetch(...handlers);
  let now = NOW;
  const deps: TicketDeps = { store: s.store, integrations, vault: memVault({ LINEAR_API_KEY: "lin_api_x" }), fetch, appUrl: APP, now: () => now };
  return { ...s, integrations, fetch, deps, setNow: (d: Date) => { now = d; } };
}

describe("sendToTicket", () => {
  it("makes the ticket and stores it on the item", async () => {
    const { deps, user, waiting, store } = await setup();
    const r = await sendToTicket(deps, user.id, waiting.id, "linear");
    expect(r).toMatchObject({ ok: true, ticket: { provider: "linear", key: "LIN-123", url: "https://linear.app/a/issue/LIN-123", id: "iss-1" }, assignee: "Nitin Kumar" });
    expect((await store.listItems(user.id)).find((i) => i.id === waiting.id)?.ticket?.key).toBe("LIN-123");
    expect(store.events.some((e) => e.type === "ticket")).toBe(true);
  });
  it("one ticket per item: a second send makes no new one", async () => {
    const { deps, user, waiting, fetch } = await setup();
    await sendToTicket(deps, user.id, waiting.id, "linear");
    const n = fetch.calls.length;
    const again = await sendToTicket(deps, user.id, waiting.id, "linear");
    expect(again.ok).toBe(true);
    expect(fetch.calls.length).toBe(n);
  });
  it("refuses when off, without a token, or for an unknown item, and sends nothing", async () => {
    const { deps, user, waiting, integrations, fetch } = await setup();
    expect(await sendToTicket(deps, user.id, waiting.id, "jira")).toEqual({ ok: false, error: "Jira is off. Turn it on in Settings." });
    expect(await sendToTicket({ ...deps, vault: memVault() }, user.id, waiting.id, "linear")).toEqual({ ok: false, error: "Add your Linear token in Settings." });
    expect(await sendToTicket(deps, user.id, "nope", "linear")).toEqual({ ok: false, error: "That item is gone." });
    integrations.update((s) => { s.providers.linear.enabled = false; });
    expect((await sendToTicket(deps, user.id, waiting.id, "linear")).ok).toBe(false);
    expect(fetch.calls).toHaveLength(0);
  });
  it("a refused token gives a plain error and never the token", async () => {
    const { deps, user, waiting, store } = await setup([() => ({ status: 401, json: { errors: [{ message: "lin_api_x is invalid" }] } })]);
    const r = await sendToTicket(deps, user.id, waiting.id, "linear");
    expect(r).toEqual({ ok: false, error: "Linear: The token was refused. Check it and its permissions." });
    expect(JSON.stringify(store.events)).not.toContain("lin_api_x");
    expect((await store.listItems(user.id)).find((i) => i.id === waiting.id)?.ticket).toBeUndefined();
  });
});

describe("saveProvider", () => {
  it("switches on only after the test passes, and keeps derived settings", async () => {
    const integrations = tmpIntegrations();
    const vault = memVault();
    const ok = mockFetch(() => ({ json: { data: { viewer: { id: "v", name: "Maruthi" }, teams: { nodes: [{ id: "t-1", key: "ENG", name: "Engineering" }] } } } }));
    const r = await saveProvider({ integrations, vault, fetch: ok, now: () => NOW }, "linear", { teamKey: "ENG" }, "lin_api_new", true);
    expect(r).toEqual({ ok: true, message: "Connected as Maruthi · team Engineering" });
    expect(integrations.read().providers.linear).toEqual({ enabled: true, teamKey: "ENG", teamId: "t-1" });
    expect(await vault.get("LINEAR_API_KEY")).toBe("lin_api_new");
    expect(enabledProviders(integrations)).toEqual([{ id: "linear", label: "Linear" }]);

    const bad = mockFetch(() => ({ status: 401, json: {} }));
    const r2 = await saveProvider({ integrations, vault, fetch: bad, now: () => NOW }, "linear", { teamKey: "ENG" }, null, true);
    expect(r2.ok).toBe(false);
    expect(integrations.read().providers.linear.enabled).toBe(false);
    expect(integrations.read().checks.linear?.message).toMatch(/refused/);
  });
  it("asks for missing settings before calling anything", async () => {
    const integrations = tmpIntegrations();
    const f = mockFetch();
    const r = await saveProvider({ integrations, vault: memVault(), fetch: f, now: () => NOW }, "jira", { site: "acme.atlassian.net", email: "", projectKey: "OPS" }, "tok12345", true);
    expect(r).toEqual({ ok: false, message: "Add the email of your Atlassian account." });
    expect(f.calls).toHaveLength(0);
  });
  it("forgetting a token switches the service off", async () => {
    const { deps } = await setup();
    await disconnectProvider(deps, "linear");
    expect(await deps.vault.get("LINEAR_API_KEY")).toBeNull();
    expect(deps.integrations.read().providers.linear.enabled).toBe(false);
  });
});

describe("syncTickets (two-way close)", () => {
  const stateIs = (type: string): Handler => (c) => ((c.body as { query?: string })?.query?.includes("DailyBriefState") ? { json: { data: { issue: { id: "iss-1", state: { type } } } } } : undefined);

  it("closes the item with “Closed in Linear” when the ticket is done", async () => {
    const { deps, user, waiting, store } = await setup([linearUsers, linearCreate, stateIs("completed")]);
    await sendToTicket(deps, user.id, waiting.id, "linear");
    const closed: string[] = [];
    const r = await syncTickets(deps, { onClosed: async (i) => { closed.push(i.id); } });
    expect(r).toMatchObject({ ran: true, checked: 1, closed: [waiting.id], errors: 0 });
    const item = (await store.listItems(user.id)).find((i) => i.id === waiting.id)!;
    expect(item).toMatchObject({ status: "done", closeReason: "Closed in Linear", closedAt: NOW.toISOString() });
    expect(closed).toEqual([waiting.id]);
  });
  it("runs at most every 30 minutes, and only asks about open items with a ticket", async () => {
    const { deps, user, waiting, fetch, setNow } = await setup([linearUsers, linearCreate, stateIs("started")]);
    await sendToTicket(deps, user.id, waiting.id, "linear");
    const before = fetch.calls.length;
    expect((await syncTickets(deps)).checked).toBe(1);
    expect(fetch.calls.length).toBe(before + 1); // one item has a ticket: one call
    setNow(new Date(NOW.getTime() + TICKET_SYNC_EVERY_MS - 60_000));
    expect((await syncTickets(deps)).ran).toBe(false);
    expect(fetch.calls.length).toBe(before + 1);
    setNow(new Date(NOW.getTime() + TICKET_SYNC_EVERY_MS));
    expect((await syncTickets(deps)).ran).toBe(true);
  });
  it("makes no calls when no item has a ticket or the service is off", async () => {
    const { deps, fetch, integrations } = await setup();
    expect((await syncTickets(deps)).checked).toBe(0);
    integrations.update((s) => { s.providers.linear.enabled = false; });
    expect((await syncTickets(deps, { force: true })).checked).toBe(0);
    expect(fetch.calls).toHaveLength(0);
  });
  it("leaves items open when the ticket is gone or the service errors", async () => {
    const { deps, user, waiting, store } = await setup([linearUsers, linearCreate, (c) => ((c.body as { query?: string })?.query?.includes("DailyBriefState") ? { status: 500, json: {} } : undefined)]);
    await sendToTicket(deps, user.id, waiting.id, "linear");
    const r = await syncTickets(deps);
    expect(r.errors).toBe(1);
    expect((await store.listItems(user.id)).find((i) => i.id === waiting.id)?.status).toBe("open");
  });
  it("an item you reopen loses the reason", async () => {
    const { deps, user, waiting, store } = await setup([linearUsers, linearCreate, stateIs("completed")]);
    await sendToTicket(deps, user.id, waiting.id, "linear");
    await syncTickets(deps);
    await store.setItemStatus(waiting.id, "open", NOW.toISOString());
    expect((await store.listItems(user.id)).find((i) => i.id === waiting.id)?.closeReason).toBeNull();
  });
});
