import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBrief } from "@/lib/brief/build";
import { listPeople } from "@/lib/people";
import { FileStore } from "@/server/local/file-store";
import { goesToInbox } from "./items";

const TZ = "Asia/Kolkata";

describe("Inbox", () => {
  it("captures without a person or a date go to the Inbox; anything with either goes to its list", () => {
    expect(goesToInbox({ person: null, dueAt: null })).toBe(true);
    expect(goesToInbox({ person: "  ", dueAt: undefined })).toBe(true);
    expect(goesToInbox({ person: "Nitin", dueAt: null })).toBe(false);
    expect(goesToInbox({ person: null, dueAt: "2026-11-27T12:30:00Z" })).toBe(false);
  });

  it("keeps Inbox items off the brief and lists until triaged, then they behave like any item", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "db-inbox-")), ".daily-brief", "state.json");
    const s = new FileStore(path);
    const user = s.addUser({ email: "m@example.com", name: "Maruthi", timeZone: TZ });
    const jot = await s.addManualItem(user.id, { kind: "owe", text: "Book the venue", person: null, dueAt: null, inbox: true }, "2026-11-26T04:00:00Z");
    const listed = await s.addManualItem(user.id, { kind: "owe", text: "Send Nitin the deck", person: "Nitin", dueAt: null }, "2026-11-26T04:00:00Z");
    expect(jot.status).toBe("inbox");
    expect(listed.status).toBe("open");

    const now = new Date("2026-11-26T12:30:00Z");
    let brief = await buildBrief(s, user, now);
    const texts = (b: typeof brief) => [...b.youOwe, ...b.waitingOn, ...b.stillOpen].map((l) => l.text);
    expect(texts(brief)).toContain("Send Nitin the deck");
    expect(texts(brief)).not.toContain("Book the venue");
    expect((await s.listItems(user.id, { status: "open" })).map((i) => i.text)).toEqual(["Send Nitin the deck"]);

    // Triage: a kind, a person and a date, then onto its list. Survives a restart.
    await s.updateItem(jot.id, { kind: "waiting", person: "Priya", dueAt: "2026-11-27T12:30:00Z" });
    await s.setItemStatus(jot.id, "open", "2026-11-26T05:00:00Z");
    const again = new FileStore(path);
    expect((await again.listItems(user.id)).find((i) => i.id === jot.id)).toMatchObject({ status: "open", kind: "waiting", person: "Priya", closedAt: null });
    brief = await buildBrief(again, user, now);
    expect(texts(brief)).toContain("Book the venue");
    expect(listPeople({ items: await again.listItems(user.id), meetings: [], now, self: ["Maruthi"] }).map((p) => p.name)).toContain("Priya");

    // Or delete it outright.
    const junk = await again.addManualItem(user.id, { kind: "owe", text: "Never mind", person: null, dueAt: null, inbox: true }, "2026-11-26T06:00:00Z");
    expect(await again.deleteItem(junk.id)).toBe(true);
    expect((await again.listItems(user.id)).some((i) => i.id === junk.id)).toBe(false);
  });
});
