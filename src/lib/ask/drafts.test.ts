import { describe, expect, it } from "vitest";
import { draftTarget, splitDrafts } from "./drafts";

describe("splitDrafts", () => {
  it("keeps a plain answer as one text part", () => {
    expect(splitDrafts("You owe Jit 6 things [1].")).toEqual([{ type: "text", text: "You owe Jit 6 things [1]." }]);
  });

  it("pulls a draft out between its markers", () => {
    const parts = splitDrafts("Here's a short one [2].\n:::draft To Jit · Slack\nHey Jit, I'll share the layouts by noon.\n\nSorry for the delay.\n:::\nWant it shorter?");
    expect(parts).toEqual([
      { type: "text", text: "Here's a short one [2]." },
      { type: "draft", to: "Jit", via: "Slack", body: "Hey Jit, I'll share the layouts by noon.\n\nSorry for the delay.", done: true },
      { type: "text", text: "Want it shorter?" },
    ]);
  });

  it("shows an unclosed draft as still being written", () => {
    const parts = splitDrafts("Sure.\n:::draft To Sashi\nHi Sashi, the visa");
    expect(parts[1]).toEqual({ type: "draft", to: "Sashi", via: null, body: "Hi Sashi, the visa", done: false });
  });

  it("copes with a draft with no header", () => {
    expect(splitDrafts(":::draft\nHello\n:::")).toEqual([{ type: "draft", to: null, via: null, body: "Hello", done: true }]);
  });

  it("maps the channel to a handoff target", () => {
    expect(draftTarget("Email")).toBe("email");
    expect(draftTarget("Slack")).toBe("slack");
    expect(draftTarget(null)).toBe("slack");
  });
});
