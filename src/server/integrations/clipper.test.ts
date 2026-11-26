// The web clipper (extensions/clipper): its Markdown conversion and API client run here on plain
// objects shaped like DOM nodes, with a fake fetch; the server side saves into a temp notes folder.
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAllowedOrigin, resetRateLimits, type ApiDeps } from "./api";
import { clipBlock, createClipRoute, INBOX_SLUG, saveClip } from "./clips";
import { memVault, NOW, seeded, tmpIntegrations } from "./test-helpers";
import { readPage } from "@/server/local/pages";

const require = createRequire(import.meta.url);
const md = require("../../../extensions/clipper/lib/markdown.js") as {
  toMarkdown: (n: unknown, base?: string) => string;
  readableRoot: (doc: unknown) => unknown;
  safeHref: (h: string, base?: string) => string | null;
};
const api = require("../../../extensions/clipper/lib/api.js") as {
  sendClip: (s: { base?: string; token?: string }, clip: Record<string, unknown>, f: typeof fetch) => Promise<{ ok: boolean; status: number; message: string; url?: string | null }>;
  cleanBase: (u: string) => string | null;
};

type N = { nodeType: number; nodeName: string; textContent: string; childNodes: N[]; getAttribute: (n: string) => string | null };
const text = (t: string): N => ({ nodeType: 3, nodeName: "#text", textContent: t, childNodes: [], getAttribute: () => null });
function el(tag: string, attrs: Record<string, string>, ...kids: Array<N | string>): N {
  const childNodes = kids.map((k) => (typeof k === "string" ? text(k) : k));
  return { nodeType: 1, nodeName: tag.toUpperCase(), childNodes, get textContent() { return childNodes.map((c) => c.textContent).join(""); }, getAttribute: (n) => (n in attrs ? attrs[n] : null) };
}

describe("Markdown from the page", () => {
  it("keeps headings, emphasis, lists, quotes and http links; drops scripts and unsafe links", () => {
    const page = el("div", {},
      el("h2", {}, "Launch notes"),
      el("p", {}, "Ship the ", el("strong", {}, "dividend"), " banner. See ", el("a", { href: "/docs" }, "docs"), " and ", el("a", { href: "javascript:alert(1)" }, "this"), "."),
      el("ul", {}, el("li", {}, "one"), el("li", {}, "two")),
      el("blockquote", {}, el("p", {}, "Quote here")),
      el("script", {}, "alert('x')"),
      el("nav", {}, "Home About"),
    );
    const out = md.toMarkdown(page, "https://example.com/post");
    expect(out).toContain("## Launch notes");
    expect(out).toContain("**dividend**");
    expect(out).toContain("[docs](https://example.com/docs)");
    expect(out).not.toContain("javascript:");
    expect(out).toContain("this");
    expect(out).toMatch(/- one\n- two/);
    expect(out).toContain("> Quote here");
    expect(out).not.toContain("alert");
    expect(out).not.toContain("Home About");
    expect(md.safeHref("data:text/html,x")).toBeNull();
    expect(md.safeHref("mailto:a@b.co")).toBe("mailto:a@b.co");
  });
  it("picks the article as the readable part", () => {
    const article = el("article", {}, el("p", {}, "x".repeat(300)));
    const doc = { body: el("body", {}), querySelector: (s: string) => (s === "article" ? article : null), querySelectorAll: () => [] };
    expect(md.readableRoot(doc)).toBe(article);
  });
});

describe("the extension's API client", () => {
  const clip = { markdown: "Hi", target: "inbox" };
  it("only talks to localhost, and needs a token", async () => {
    expect(api.cleanBase("http://localhost:4242/x")).toBe("http://localhost:4242");
    expect(api.cleanBase("https://evil.example.com")).toBeNull();
    const f = vi.fn();
    expect((await api.sendClip({ base: "https://evil.example.com", token: "t" }, clip, f as never)).ok).toBe(false);
    expect((await api.sendClip({ base: "http://127.0.0.1:4242" }, clip, f as never)).message).toMatch(/token/);
    expect(f).not.toHaveBeenCalled();
  });
  it("posts the clip with the token and words each refusal", async () => {
    const calls: Array<[string, RequestInit]> = [];
    const respond = (status: number, body: unknown) => (async (u: string, init: RequestInit) => { calls.push([u, init]); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
    const ok = await api.sendClip({ base: "http://localhost:4242", token: "dbk_x" }, clip, respond(201, { url: "http://localhost:4242/notes/inbox" }));
    expect(ok).toMatchObject({ ok: true, message: "Added to your Inbox note.", url: "http://localhost:4242/notes/inbox" });
    expect(calls[0][0]).toBe("http://localhost:4242/api/v1/clips");
    expect((calls[0][1].headers as Record<string, string>).Authorization).toBe("Bearer dbk_x");
    expect((await api.sendClip({ base: "http://localhost:4242", token: "x" }, clip, respond(401, {}))).message).toMatch(/token was refused/);
    expect((await api.sendClip({ base: "http://localhost:4242", token: "x" }, clip, respond(403, {}))).message).toMatch(/origin/);
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect((await api.sendClip({ base: "http://localhost:4242", token: "x" }, clip, down)).message).toMatch(/Couldn't reach/);
  });
});

describe("saving clips", () => {
  let dir = "";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "db-clip-")); resetRateLimits(); });

  it("writes a heading, the source link and the date", () => {
    const b = clipBlock({ markdown: "Body", title: "A [post]", url: "https://www.example.com/a)b", kind: "selection" }, new Date("2026-11-26T10:00:00Z"));
    expect(b).toBe("## A post\n\n*Selection from [example.com](https://www.example.com/a%29b) on 26 Nov 2026*\n\nBody\n");
    expect(clipBlock({ markdown: "x", url: "javascript:alert(1)" }, new Date())).toContain("from the web");
  });
  it("creates the Inbox note, then appends to it; or makes a new note", () => {
    const now = new Date("2026-11-26T10:00:00Z");
    expect(saveClip({ markdown: "First", target: "inbox" }, now, "UTC", dir)).toEqual({ slug: INBOX_SLUG });
    saveClip({ markdown: "Second", target: "inbox" }, now, "UTC", dir);
    const inbox = readPage(INBOX_SLUG, dir)!;
    expect(inbox.markdown).toMatch(/^# Inbox/);
    expect(inbox.markdown).toMatch(/First[\s\S]*---[\s\S]*Second/);
    const n = saveClip({ markdown: "Article body", target: "new", title: "Great read", url: "https://example.com" }, now, "UTC", dir);
    const page = readPage(n.slug, dir)!;
    expect(page.title).toBe("Great read");
    expect(page.markdown).toContain("Article body");
  });
  it("POST /api/v1/clips needs the token, checks the body, and saves", async () => {
    process.env.DAILY_BRIEF_DIR = dir;
    const s = await seeded();
    const afterWrite = vi.fn(async () => {});
    const deps: ApiDeps = { store: s.store, integrations: tmpIntegrations(), vault: memVault({ LOCAL_API_TOKEN: "dbk_tok_1234567890" }), appUrl: "http://localhost:4242", now: () => NOW, afterWrite };
    const post = (body: unknown, token = "dbk_tok_1234567890") => createClipRoute(new Request("http://localhost:4242/api/v1/clips", { method: "POST", headers: { host: "localhost:4242", authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), deps);
    expect((await post({ markdown: "x" }, "dbk_wrong")).status).toBe(401);
    expect((await post({ markdown: "" })).status).toBe(400);
    expect((await post({ markdown: "x", extra: 1 })).status).toBe(400);
    const r = await post({ markdown: "Clipped text", title: "T", url: "https://example.com/p" });
    expect(r.status).toBe(201);
    expect(await r.json()).toMatchObject({ ok: true, slug: "inbox", url: "http://localhost:4242/notes/inbox" });
    expect(readPage("inbox", dir)!.markdown).toContain("Clipped text");
    expect(afterWrite).toHaveBeenCalled();
  });
  it("an extension origin you allowed is accepted, others are not", () => {
    expect(isAllowedOrigin("chrome-extension://abcdefghijklmnop", ["chrome-extension://abcdefghijklmnop"])).toBe(true);
    expect(isAllowedOrigin("moz-extension://abcdefgh-1234", [])).toBe(false);
  });
});
