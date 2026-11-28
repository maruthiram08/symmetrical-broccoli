import { describe, expect, it } from "vitest";
import { hasBacklog, newTickState } from "./scheduler";

describe("reading backlog between polls", () => {
  it("starts true, so a restart mid re-read carries on without waiting for the next poll", () => {
    expect(newTickState().backlog).toBe(true);
  });
  it("keeps going only while meetings are left and the last run made progress", () => {
    expect(hasBacklog([{ processed: 5, remaining: 20 }])).toBe(true);
    expect(hasBacklog([{ processed: 5, remaining: 0 }])).toBe(false);
    expect(hasBacklog([{ processed: 0, remaining: 3 }])).toBe(false); // only failed ones waiting to retry
    expect(hasBacklog([{ processed: 5, remaining: 20, stoppedBy: "credit" }])).toBe(false);
  });
});
