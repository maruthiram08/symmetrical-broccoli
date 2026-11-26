import { describe, expect, it } from "vitest";
import { nameLike, parseActionItems, splitOwner } from "./parse";

// Hand-written fixtures in the shapes a Flow Summary can take (no real summary was available).
const NEXT_STEPS_COLON = `## Summary
The team reviewed the Q4 banner and agreed on the copy.

## Key decisions
- Ship the banner on Monday

## Next steps
- Maruthi: send Nitin the final banner text by tonight
- Nitin to update the hero image
- [ ] Asha – book the venue for the offsite
- [x] Ravi will share the analytics dashboard
- Follow up with legal on the disclaimer

## Open questions
- Who owns the FAQ page?
`;

const ACTION_ITEMS_GROUPED = `# Launch sync

**Overview**
Launch is on track.

**Action items**

**Maruthi**
- Confirm the launch date with marketing
- Send the press list to Asha

**Asha & Ravi**
1. Draft the announcement post
2. Review the pricing page (owner: Ravi)

**Notes**
- Discussed timelines
`;

const FOLLOW_UPS_NESTED = `### 📝 Summary
Short 1:1.

### ✅ Follow-ups
* **Nitin:**
  * Share the hiring plan
  * Set up the interview loop
* **Maru:**
  * Review Nitin's plan by Friday
* Need to schedule the next 1:1

### Decisions
* Hire two engineers
`;

const PLAIN_COLON_HEADING = `Recap of the design crit.

Next steps:
- Iterate on the onboarding flow — Owner: Asha
- Send the updated mocks (Maruthi)
- Send the deck (Friday)

Other notes:
- Coffee was great
`;

describe("parseActionItems", () => {
  it("reads a ## Next steps section with Name: and Name to prefixes and checkboxes", () => {
    expect(parseActionItems(NEXT_STEPS_COLON)).toEqual([
      { text: "Send Nitin the final banner text by tonight", owner: "Maruthi" },
      { text: "Update the hero image", owner: "Nitin" },
      { text: "Book the venue for the offsite", owner: "Asha" },
      { text: "Share the analytics dashboard", owner: "Ravi", done: true },
      { text: "Follow up with legal on the disclaimer", owner: null },
    ]);
  });

  it("reads owners from bold lines grouping bullets, and stops at the next section", () => {
    expect(parseActionItems(ACTION_ITEMS_GROUPED)).toEqual([
      { text: "Confirm the launch date with marketing", owner: "Maruthi" },
      { text: "Send the press list to Asha", owner: "Maruthi" },
      { text: "Draft the announcement post", owner: "Asha & Ravi" },
      { text: "Review the pricing page", owner: "Ravi" },
    ]);
  });

  it("reads nested owner bullets under an emoji Follow-ups heading", () => {
    expect(parseActionItems(FOLLOW_UPS_NESTED)).toEqual([
      { text: "Share the hiring plan", owner: "Nitin" },
      { text: "Set up the interview loop", owner: "Nitin" },
      { text: "Review Nitin's plan by Friday", owner: "Maru" },
      { text: "Need to schedule the next 1:1", owner: null },
    ]);
  });

  it("reads a plain 'Next steps:' line and trailing owners, but not a weekday as owner", () => {
    expect(parseActionItems(PLAIN_COLON_HEADING)).toEqual([
      { text: "Iterate on the onboarding flow", owner: "Asha" },
      { text: "Send the updated mocks", owner: "Maruthi" },
      { text: "Send the deck (Friday)", owner: null },
    ]);
  });

  it("returns nothing for a missing, empty or section-less summary", () => {
    expect(parseActionItems(null)).toEqual([]);
    expect(parseActionItems("")).toEqual([]);
    expect(parseActionItems("## Summary\n- We talked about the roadmap\n")).toEqual([]);
  });

  it("drops duplicates and strips links and emphasis", () => {
    const r = parseActionItems("## Action Items\n- **Asha**: read [the spec](https://x.test)\n- Asha: read the spec\n");
    expect(r).toEqual([{ text: "Read the spec", owner: "Asha" }]);
  });

  it("handles 'Action items & next steps' and numbered lists", () => {
    const r = parseActionItems("## Action Items & Next Steps\n1) Ravi to fix the build\n2. Maruthi: file the bug\n## Risks\n- slow CI\n");
    expect(r.map((x) => x.owner)).toEqual(["Ravi", "Maruthi"]);
  });
});

describe("owner helpers", () => {
  it("tells names from verbs", () => {
    expect(nameLike("Asha Rao")).toBe(true);
    expect(nameLike("Asha & Ravi")).toBe(true);
    expect(nameLike("Need")).toBe(false);
    expect(nameLike("Send the deck")).toBe(false);
    expect(nameLike("Friday")).toBe(false);
  });
  it("splits owner prefixes", () => {
    expect(splitOwner("Team to finalize copy")).toEqual({ owner: "Team", text: "Finalize copy" });
    expect(splitOwner("Q3 roadmap: finalize")).toEqual({ owner: null, text: "Q3 roadmap: finalize" });
    expect(splitOwner("@ravi: hmm")).toEqual({ owner: null, text: "@ravi: hmm" });
  });
});

describe("Wispr Flow's real summary format", () => {
  const summary = `### Context
Some notes.

### Next Steps
- (Speaker 1) Share the Notion requirement document with the team
- (Maruthi Ram M N V) Present chart alerts in PBR next week, Monday or Tuesday
- (Tarun) Align backend on the futures categorization revamp

### Decisions Made
- Ship the banner as is`;
  it("reads the owner in parentheses, and leaves Speaker N unknown", () => {
    const items = parseActionItems(summary);
    expect(items.map((i) => [i.owner, i.text])).toEqual([
      [null, "Share the Notion requirement document with the team"],
      ["Maruthi Ram M N V", "Present chart alerts in PBR next week, Monday or Tuesday"],
      ["Tarun", "Align backend on the futures categorization revamp"],
    ]);
  });
});
