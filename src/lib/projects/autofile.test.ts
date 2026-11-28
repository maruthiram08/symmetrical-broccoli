import { describe, expect, it } from "vitest";
import { buildModel, isClosedProject, judge, keywordList, upsertExample, type FilingExample, type ProjectInfo } from "./autofile";

const projects: ProjectInfo[] = [
  { slug: "corporate-actions", title: "Corporate actions", keywords: ["stock split", "dividend"] },
  { slug: "chart-alerts", title: "Chart alerts", keywords: [] },
  { slug: "dubai-move", title: "Dubai move", keywords: ["visa"] },
];
const corpus = [
  "Create a ticket for the Sandisk stock split case", "Send Nitin the dividend tag text", "Share the chart alerts requirement with Jay",
  "Share the designs with Jeet", "Share the doc with the group", "Share the earnings tag ticket", "Share the QA sheet", "Review the PR",
  "Start the MOFA attestation application", "Get the UAE visa medical tests done", "Email the attestation application form",
  // Everything else a few weeks of meetings bring, so rare words stand out as they do in real use.
  ...Array.from({ length: 40 }, (_, k) => `Follow up with person ${k} on the open ticket and share notes`),
];
const ex = (itemId: string, text: string, project: string | null, extra: Partial<FilingExample> = {}): FilingExample => ({ itemId, text, project, at: "2026-11-26T00:00:00Z", ...extra });

describe("judge", () => {
  const m = buildModel(projects, [], corpus);

  it("files an item by a project's keyword or title phrase", () => {
    expect(judge({ id: "1", text: "Create a ticket for the Sandisk stock split case" }, m)).toMatchObject({ project: "corporate-actions", why: "matched “stock split”" });
    expect(judge({ id: "2", text: "Send Nitin the dividend tag text" }, m).project).toBe("corporate-actions");
    expect(judge({ id: "3", text: "Share the chart alerts requirement with Jay" }, m).project).toBe("chart-alerts");
  });

  it("leaves an item unfiled when nothing clearly fits", () => {
    expect(judge({ id: "4", text: "Share the designs with Jeet" }, m)).toMatchObject({ project: null, why: null });
  });

  it("leaves it unfiled when two projects fit about equally", () => {
    expect(judge({ id: "5", text: "Check whether the dividend tag shows next to the visa" }, m).project).toBeNull();
  });

  it("uses the meeting title only when the item's own words point nowhere", () => {
    expect(judge({ id: "6", text: "Send the scope artifact as PDF", title: "Stock Split Tag Implementation" }, m))
      .toMatchObject({ project: "corporate-actions", why: "from the meeting “Stock Split Tag Implementation”" });
    // Its own words name another project: the meeting title doesn't pull it away.
    expect(judge({ id: "7", text: "Share the chart alerts requirement with Jay", title: "Dividend Corporate Action" }, m).project).toBe("chart-alerts");
  });

  it("learns from what you filed by hand", () => {
    const before = judge({ id: "8", text: "Email the attestation application form", title: "Option Screener Review" }, m);
    expect(before.project).not.toBe("dubai-move");
    const taught = buildModel(projects, [ex("x", "Start the MOFA attestation application", "dubai-move")], corpus);
    expect(judge({ id: "8", text: "Email the attestation application form", title: "Option Screener Review" }, taught).project).toBe("dubai-move");
  });

  it("learns from a correction: a project you took an item out of loses those words", () => {
    const projects2: ProjectInfo[] = [{ slug: "earnings", title: "Earnings", keywords: ["earnings tag"] }, { slug: "qa", title: "QA", keywords: [] }];
    const m0 = buildModel(projects2, [], corpus);
    expect(judge({ id: "9", text: "Share the earnings tag ticket with QA sheet" }, m0).project).toBe("earnings");
    const m1 = buildModel(projects2, [
      ex("a", "Share the earnings tag ticket with QA sheet", "qa", { not: ["earnings"] }),
      ex("b", "Send the earnings tag ticket to the QA sheet", "qa", { not: ["earnings"] }),
    ], corpus);
    expect(judge({ id: "10", text: "Put the earnings tag ticket in the QA sheet" }, m1).project).toBe("qa");
  });

  it("a one-word project name files on its own only when the word is rare", () => {
    const one: ProjectInfo[] = [{ slug: "chart", title: "Chart", keywords: ["chart"] }, { slug: "sandisk", title: "Sandisk", keywords: [] }];
    // "chart" in a fifth of everything: too common to file on the word alone.
    const common = [...corpus, ...Array.from({ length: 12 }, (_, k) => `Look at chart number ${k}`)];
    const m1 = buildModel(one, [], common);
    expect(judge({ id: "c1", text: "Keep the chart timeframe when switching contracts" }, m1).project).toBeNull();
    // A rare word ("Sandisk", in one item) still files on its own.
    expect(judge({ id: "c2", text: "Create a ticket for the Sandisk stock split case" }, m1).project).toBe("sandisk");
  });

  it("files nothing without projects", () => {
    expect(judge({ id: "1", text: "stock split" }, buildModel([], [], corpus)).project).toBeNull();
  });
});

describe("helpers", () => {
  it("reads keywords as a list or a comma string", () => {
    expect(keywordList(["a", " b "])).toEqual(["a", "b"]);
    expect(keywordList("stock split, dividend; bonus")).toEqual(["stock split", "dividend", "bonus"]);
    expect(keywordList(3)).toEqual([]);
  });
  it("knows closed projects", () => {
    expect(isClosedProject("done")).toBe(true);
    expect(isClosedProject("Archived")).toBe(true);
    expect(isClosedProject("active")).toBe(false);
  });
  it("replaces an item's example and keeps its rejections", () => {
    let l = upsertExample([], ex("1", "t", "b", { not: ["a"] }));
    l = upsertExample(l, ex("1", "t", "c"));
    expect(l).toEqual([{ ...ex("1", "t", "c"), not: ["a"] }]);
    // Filing it back into a project it was rejected from clears that rejection.
    expect(upsertExample(l, ex("1", "t", "a"))).toEqual([ex("1", "t", "a")]);
  });
});
