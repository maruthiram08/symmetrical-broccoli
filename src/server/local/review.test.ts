import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// The export route reads the app's own store: point it at a temp folder first.
const dir = mkdtempSync(join(tmpdir(), "db-review-"));
process.env.DAILY_BRIEF_DIR = dir;
process.env.TOKEN_ENCRYPTION_KEY ??= Buffer.alloc(32).toString("base64");

describe("review export route", () => {
  beforeAll(async () => {
    const { getFileStore: getStore } = await import("./app");
    const store = getStore();
    const u = store.addUser({ email: "you@this-mac", name: "Maruthi", aliases: [], timeZone: "Asia/Kolkata" });
    const m = (await store.upsertMeeting({ userId: u.id, providerMeetingId: "p1", title: "Launch sync", startedAt: "2026-11-03T05:00:00Z", participants: [] })).meeting;
    await store.commitExtraction({ meetingId: m.id, userId: u.id, at: "2026-11-03T06:00:00Z", closes: [], newItems: [
      { kind: "owe", text: "Send Nitin the deck", person: "Nitin", quote: "I'll send the deck tonight", meetingId: m.id, dueAt: null },
    ] });
  });

  const get = async (kind: string, key: string, q = "") => {
    const { GET } = await import("@/app/api/review/[kind]/[key]/route");
    return GET(new Request(`http://localhost/api/review/${kind}/${key}${q}`), { params: Promise.resolve({ kind, key }) });
  };

  it("downloads the month as an HTML file without quotes", async () => {
    const r = await get("month", "2026-11");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    expect(r.headers.get("content-disposition")).toBe('attachment; filename="daily-brief-review-2026-11.html"');
    const html = await r.text();
    expect(html).toContain("Send Nitin the deck");
    expect(html).not.toContain("send the deck tonight");
  });

  it("includes quotes with ?quotes=1, and does years", async () => {
    expect(await (await get("month", "2026-11", "?quotes=1")).text()).toContain("send the deck tonight");
    expect(await (await get("year", "2026")).text()).toContain("2026 in review");
  });

  it("404s on a bad kind or key", async () => {
    expect((await get("week", "2026-11")).status).toBe(404);
    expect((await get("month", "2026-13")).status).toBe(404);
  });
});
