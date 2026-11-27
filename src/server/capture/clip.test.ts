import { describe, expect, it } from "vitest";
import { MemoryStore } from "@/server/store";
import { captureClip } from "./clip";

describe("captureClip", () => {
  it("adds the item with its Slack origin, and lands in the lists when it names a person", async () => {
    const store = new MemoryStore();
    const user = { ...store.addUser({ email: "m@x.com", timeZone: "Asia/Kolkata", briefTime: "18:00" }), name: "Maruthi Ram", aliases: [] };
    const link = "https://acme.slack.com/archives/C04ABCDEF/p1764226920123456";
    const r = await captureClip(store, user, { text: "Nitin  10:42 AM\nCan you send the banner text?", html: `<a href="${link}">10:42 AM</a>` }, new Date("2026-11-27T07:00:00Z"));
    expect(r).toMatchObject({ kind: "owe", person: "Nitin", inbox: false, slack: true });
    const [item] = await store.listItems(user.id);
    expect(item).toMatchObject({ source: "manual", status: "open", quote: "Can you send the banner text?", origin: { app: "slack", url: link, from: "Nitin" } });
  });

  it("goes to the Inbox with no person and no date, and ignores an empty clipboard", async () => {
    const store = new MemoryStore();
    const user = store.addUser({ email: "m@x.com", timeZone: "Asia/Kolkata", briefTime: "18:00" });
    expect(await captureClip(store, user, { text: "Book the venue" })).toMatchObject({ inbox: true });
    expect(await captureClip(store, user, { text: "  " })).toBeNull();
  });
});
