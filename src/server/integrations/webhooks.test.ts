import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BACKOFF_MS, deliverDue, diffItems, MAX_ATTEMPTS, queueChanges, runWebhooks, sendTest, sign, SIGNATURE_HEADER, validWebhookUrl, type WebhookDeps } from "./webhooks";
import { memVault, mockFetch, NOW, seeded, tmpIntegrations, type Handler } from "./test-helpers";

const URL1 = "https://hooks.example.com/db";

async function setup(answer: Handler = () => ({ status: 200, json: {} }), opts: { secret?: boolean; enabled?: boolean } = {}) {
  const s = await seeded();
  const integrations = tmpIntegrations();
  integrations.update((st) => { st.webhooks = { enabled: opts.enabled ?? true, urls: [URL1], events: ["item.created", "item.closed", "decision.made"] }; });
  const fetch = mockFetch(answer);
  let now = NOW;
  const deps: WebhookDeps = { store: s.store, integrations, vault: memVault(opts.secret === false ? {} : { WEBHOOK_SECRET: "whsec_test_secret" }), fetch, appUrl: "http://localhost:4242", now: () => now };
  return { ...s, integrations, fetch, deps, setNow: (d: Date) => { now = d; } };
}

describe("signing", () => {
  it("is HMAC-SHA256 over `${t}.${body}`, like docs/API.md shows", () => {
    const body = '{"type":"item.created"}';
    const sig = sign("whsec_x", body, 1764151200);
    const mac = createHmac("sha256", "whsec_x").update(`1764151200.${body}`).digest("hex");
    expect(sig).toBe(`t=1764151200,v1=${mac}`);
  });
  it("accepts only http(s) URLs without credentials", () => {
    expect(validWebhookUrl(" https://x.com/h ")).toBe("https://x.com/h");
    expect(validWebhookUrl("http://localhost:9000/h")).toBe("http://localhost:9000/h");
    expect(validWebhookUrl("ftp://x.com")).toBeNull();
    expect(validWebhookUrl("https://user:pw@x.com")).toBeNull();
    expect(validWebhookUrl("not a url")).toBeNull();
  });
});

describe("diffItems", () => {
  it("new decisions are decision.made, other new items item.created, open -> done item.closed", async () => {
    const { owe, waiting, decision } = await seeded();
    expect(diffItems([owe, decision], {}).map((c) => c.event)).toEqual(["item.created", "decision.made"]);
    expect(diffItems([{ ...waiting, status: "done" }], { [waiting.id]: "open" }).map((c) => c.event)).toEqual(["item.closed"]);
    expect(diffItems([{ ...waiting, status: "open" }], { [waiting.id]: "done" })).toEqual([]); // reopened: nothing
  });
});

describe("queue and deliver", () => {
  it("the first run only looks: history is never sent", async () => {
    const { deps, fetch, integrations } = await setup();
    expect(await queueChanges(deps)).toBe(0);
    await deliverDue(deps);
    expect(fetch.calls).toHaveLength(0);
    expect(integrations.read().primed).toBe(true);
  });

  it("sends item.created, item.closed and decision.made once each, signed", async () => {
    const { deps, fetch, store, user, waiting } = await setup();
    await runWebhooks(deps); // prime
    await store.addManualItem(user.id, { kind: "owe", text: "Book the venue", person: null, dueAt: null }, NOW.toISOString());
    await store.setItemStatus(waiting.id, "done", NOW.toISOString());
    await store.commitExtraction({ meetingId: (await store.listMeetingsBetween(user.id, "0", "9"))[0].id, userId: user.id, at: NOW.toISOString(), closes: [], newItems: [{ kind: "decision", text: "Ship on Monday", person: null, quote: "Monday it is", meetingId: "m", dueAt: null }] });
    await runWebhooks(deps);
    expect(fetch.calls.map((c) => c.headers["x-daily-brief-event"]).sort()).toEqual(["decision.made", "item.closed", "item.created"]);
    for (const c of fetch.calls) {
      expect(c.url).toBe(URL1);
      expect(c.method).toBe("POST");
      expect(c.headers["content-type"]).toBe("application/json");
      const sig = c.headers[SIGNATURE_HEADER.toLowerCase()];
      const [, t, v1] = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(sig)!;
      expect(createHmac("sha256", "whsec_test_secret").update(`${t}.${JSON.stringify(c.body)}`).digest("hex")).toBe(v1);
      expect(Number(t)).toBe(Math.floor(NOW.getTime() / 1000));
    }
    const closed = fetch.calls.find((c) => c.headers["x-daily-brief-event"] === "item.closed")!.body as { type: string; data: { item: Record<string, unknown> } };
    expect(closed.type).toBe("item.closed");
    expect(closed.data.item).toMatchObject({ id: waiting.id, status: "done", kind: "waiting", meeting: { title: "Banner sync" }, url: `http://localhost:4242/item/${waiting.id}` });
    await runWebhooks(deps);
    expect(fetch.calls).toHaveLength(3); // nothing new, nothing sent again
  });

  it("only the events you picked", async () => {
    const { deps, fetch, store, user, integrations } = await setup();
    integrations.update((s) => { s.webhooks.events = ["item.closed"]; });
    await runWebhooks(deps);
    await store.addManualItem(user.id, { kind: "owe", text: "x", person: null, dueAt: null }, NOW.toISOString());
    await runWebhooks(deps);
    expect(fetch.calls).toHaveLength(0);
  });

  it("retries with backoff, then gives up", async () => {
    const { deps, fetch, store, user, integrations, setNow } = await setup(() => ({ status: 503, json: {} }));
    await runWebhooks(deps);
    await store.addManualItem(user.id, { kind: "owe", text: "x", person: null, dueAt: null }, NOW.toISOString());
    await runWebhooks(deps);
    expect(fetch.calls).toHaveLength(1);
    let t = NOW.getTime();
    // Not due yet: nothing is sent.
    setNow(new Date(t + BACKOFF_MS[0] - 1000));
    await deliverDue(deps);
    expect(fetch.calls).toHaveLength(1);
    for (let k = 0; k < BACKOFF_MS.length; k++) {
      t += BACKOFF_MS[k];
      setNow(new Date(t));
      await deliverDue(deps);
      expect(fetch.calls).toHaveLength(k + 2);
    }
    expect(fetch.calls).toHaveLength(MAX_ATTEMPTS);
    expect(integrations.read().outbox).toHaveLength(0);
    expect(integrations.read().recent.at(-1)).toMatchObject({ outcome: "failed", attempts: MAX_ATTEMPTS, status: 503 });
    // Every attempt carries the same delivery id, so the receiver can drop repeats.
    expect(new Set(fetch.calls.map((c) => c.headers["x-daily-brief-delivery"])).size).toBe(1);
  });

  it("a delivery that fails once goes through on the retry", async () => {
    let n = 0;
    const { deps, store, user, integrations, setNow } = await setup(() => (++n === 1 ? undefined : { status: 204 }));
    await runWebhooks(deps);
    await store.addManualItem(user.id, { kind: "owe", text: "x", person: null, dueAt: null }, NOW.toISOString());
    await runWebhooks(deps);
    expect(integrations.read().outbox[0]).toMatchObject({ attempts: 1, nextAt: new Date(NOW.getTime() + BACKOFF_MS[0]).toISOString() });
    setNow(new Date(NOW.getTime() + BACKOFF_MS[0]));
    expect(await deliverDue(deps)).toEqual({ delivered: 1, retrying: 0, failed: 0 });
    expect(integrations.read().outbox).toHaveLength(0);
  });

  it("off by default: nothing is watched or sent", async () => {
    const { deps, fetch, store, user, integrations } = await setup(undefined, { enabled: false });
    await runWebhooks(deps);
    await store.addManualItem(user.id, { kind: "owe", text: "x", person: null, dueAt: null }, NOW.toISOString());
    await runWebhooks(deps);
    expect(fetch.calls).toHaveLength(0);
    expect(integrations.read().primed).toBe(false);
    expect(tmpIntegrations().read().webhooks.enabled).toBe(false);
  });

  it("never sends unsigned", async () => {
    const { deps, fetch, store, user, integrations } = await setup(undefined, { secret: false });
    await runWebhooks(deps);
    await store.addManualItem(user.id, { kind: "owe", text: "x", person: null, dueAt: null }, NOW.toISOString());
    await runWebhooks(deps);
    expect(fetch.calls).toHaveLength(0);
    expect(integrations.read().outbox).toHaveLength(1); // kept until there is a secret
  });

  it("drops deliveries for a URL you removed", async () => {
    const { deps, fetch, store, user, integrations } = await setup(() => ({ status: 500 }));
    await runWebhooks(deps);
    await store.addManualItem(user.id, { kind: "owe", text: "x", person: null, dueAt: null }, NOW.toISOString());
    await queueChanges(deps);
    integrations.update((s) => { s.webhooks.urls = ["https://other.example.com"]; });
    await deliverDue(deps);
    expect(fetch.calls).toHaveLength(0);
    expect(integrations.read().outbox).toHaveLength(0);
  });

  it("Send a test pings each URL", async () => {
    const { deps, fetch } = await setup(() => ({ status: 200 }));
    expect(await sendTest(deps)).toEqual([{ url: URL1, status: 200, ok: true }]);
    expect(fetch.calls[0].headers["x-daily-brief-event"]).toBe("ping");
    expect((fetch.calls[0].body as { type: string }).type).toBe("ping");
  });
});
