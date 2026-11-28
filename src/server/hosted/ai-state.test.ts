import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadAiFor, persistAi } from "./ai-state";
import { HostedStore } from "./store";
import { memDb, TEST_KEY } from "./testing";

describe("hosted AI state", () => {
  it("loads, changes with the AiStore API, and writes back only when changed", async () => {
    const store = new HostedStore(memDb().db, null, TEST_KEY);
    const id = randomUUID();
    await store.ensureUser(id, "a@x.com");
    const ai = await loadAiFor(store, id);
    expect(ai.nudges()).toEqual([]);
    await persistAi(store, id, ai);
    expect(await store.getAiState(id)).toBeNull();
    ai.saveNudge({ itemId: "i1", text: "Any news?", source: "template", createdAt: "x" });
    ai.markChecked(["d1"], true);
    await persistAi(store, id, ai);
    const again = await loadAiFor(store, id);
    expect(again.nudge("i1")?.text).toBe("Any news?");
    expect(again.primed()).toBe(true);
    expect(again.checkedSet().has("d1")).toBe(true);
  });
});
