import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TYPES } from "@/lib/structure/note-types";
import { FileStore } from "@/server/local/file-store";
import { autoFileProjects, naturalLabel, previewProject, readExamples, recordFiling, recordFilings, removeProject, suggestProjects } from "./autofile";
import { createTypedNote, projectRows, setNoteProperties } from "./notes";

const AT = "2026-11-26T10:00:00.000Z";
const project = DEFAULT_TYPES.find((t) => t.id === "project")!;
let dir: string;
const before = process.env.DAILY_BRIEF_DIR;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "db-autofile-")); process.env.DAILY_BRIEF_DIR = dir; });
afterEach(() => { if (before === undefined) delete process.env.DAILY_BRIEF_DIR; else process.env.DAILY_BRIEF_DIR = before; });

const item = (text: string) => ({ kind: "owe" as const, text, person: "Nitin", quote: "q", dueAt: null });
const filler = Array.from({ length: 30 }, (_, k) => item(`Follow up with person ${k} on the open ticket and share notes`));

async function setup() {
  const store = new FileStore(join(dir, ".daily-brief", "state.json"));
  const u = store.addUser({ email: "you@this-mac", name: "Maruthi" });
  const add = async (title: string, texts: string[]) => {
    const { meeting } = await store.upsertMeeting({ userId: u.id, providerMeetingId: title, title, startedAt: AT, participants: [] });
    await store.commitExtraction({ meetingId: meeting.id, userId: u.id, newItems: texts.map((t) => ({ ...item(t), meetingId: meeting.id })), closes: [], at: AT });
    return meeting;
  };
  return { store, u, add };
}

const byText = async (store: FileStore, userId: string) => new Map((await store.listItems(userId)).map((i) => [i.text, i]));

describe("automatic project filing", () => {
  it("files each item of a mixed meeting into its own project, and leaves the unclear ones", async () => {
    const { store, u, add } = await setup();
    createTypedNote(project, "Corporate actions", "2026-11-26", dir);
    setNoteProperties("corporate-actions", { keywords: ["stock split", "dividend"] }, dir);
    createTypedNote(project, "Chart alerts", "2026-11-26", dir);
    await add("Filler", filler.map((f) => f.text));
    await add("Sprint review", ["Create a ticket for the Sandisk stock split case", "Share the chart alerts requirement with Jay", "Book the team lunch"]);
    const r = await autoFileProjects(store, u.id);
    expect(r.filed).toBe(2);
    const items = await byText(store, u.id);
    expect(items.get("Create a ticket for the Sandisk stock split case")).toMatchObject({ project: "corporate-actions", projectBy: "auto", projectWhy: "matched “stock split”" });
    expect(items.get("Share the chart alerts requirement with Jay")).toMatchObject({ project: "chart-alerts", projectBy: "auto" });
    expect(items.get("Book the team lunch")?.project ?? null).toBeNull();
  });

  it("files a new meeting's items as soon as it is read (the store's afterCommit)", async () => {
    const { store, u, add } = await setup();
    createTypedNote(project, "Chart alerts", "2026-11-26", dir);
    store.afterCommit = (userId) => autoFileProjects(store, userId);
    await add("Filler", filler.map((f) => f.text));
    await add("Alerts", ["Split the chart alerts scope into phases"]);
    expect((await byText(store, u.id)).get("Split the chart alerts scope into phases")).toMatchObject({ project: "chart-alerts", projectBy: "auto" });
  });

  it("never moves what you filed, and learns from your corrections", async () => {
    const { store, u, add } = await setup();
    createTypedNote(project, "Dubai move", "2026-11-26", dir);
    setNoteProperties("dubai-move", { keywords: ["visa"] }, dir);
    createTypedNote(project, "Options screener", "2026-11-26", dir);
    await add("Filler", filler.map((f) => f.text));
    await add("Options Screener Review", ["Email the attestation application form", "Fill the attestation application form tonight", "Share the screener folder"]);
    await add("UAE Visa", ["Start the MOFA attestation application"]);
    await autoFileProjects(store, u.id);
    let items = await byText(store, u.id);
    // The meeting title pulled the attestation items into the screener project.
    expect(items.get("Email the attestation application form")?.project).toBe("options-screener");

    // You move one to Dubai move: it's yours now, the similar one follows, the folder one stays.
    const moved = { ...items.get("Email the attestation application form")! };
    await store.updateItem(moved.id, { project: "dubai-move", projectBy: "you", projectWhy: null });
    await recordFiling(store, u.id, moved, "dubai-move", AT);
    items = await byText(store, u.id);
    expect(items.get("Email the attestation application form")).toMatchObject({ project: "dubai-move", projectBy: "you" });
    expect(items.get("Fill the attestation application form tonight")).toMatchObject({ project: "dubai-move", projectBy: "auto" });
    expect(readExamples()).toEqual([expect.objectContaining({ itemId: moved.id, project: "dubai-move", not: ["options-screener"], title: "Options Screener Review" })]);
    expect(JSON.parse(readFileSync(join(dir, ".daily-brief", "project-filing.json"), "utf8")).version).toBe(1);

    // You take one out of every project: it stays out.
    const out = { ...items.get("Share the screener folder")! };
    await store.updateItem(out.id, { project: null, projectBy: "you", projectWhy: null });
    await recordFiling(store, u.id, out, null, AT);
    expect((await byText(store, u.id)).get("Share the screener folder")).toMatchObject({ project: null, projectBy: "you" });
  });

  it("files nothing into a project marked done", async () => {
    const { store, u, add } = await setup();
    createTypedNote(project, "Chart alerts", "2026-11-26", dir);
    setNoteProperties("chart-alerts", { status: "done" }, dir);
    await add("Alerts", ["Share the chart alerts requirement with Jay"]);
    expect((await autoFileProjects(store, u.id)).filed).toBe(0);
  });

  it("suggests projects from topics no project covers", async () => {
    const { store, u, add } = await setup();
    createTypedNote(project, "Chart alerts", "2026-11-26", dir);
    await add("Stock split tag", ["Share stock split designs"]);
    await add("Sandisk stock split", ["Create the stock split ticket"]);
    await add("Chart alerts scoping", ["Share the alerts data"]);
    await add("Chart alerts plan", ["Name the alerts feature"]);
    const items = await store.listItems(u.id);
    const meetings = await store.listMeetingsBetween(u.id, "0000", "9999");
    const s = suggestProjects(items, meetings, [{ slug: "chart-alerts", title: "Chart alerts", keywords: [] }], "2026-01-01T00:00:00Z");
    expect(s).toEqual([{ key: "stock split", label: "Stock split", meetings: 2, items: 2 }]);
  });

  it("names a topic as the meeting titles spell it", () => {
    expect(naturalLabel("earning tag", ["Weekly sync", "Earnings Tag QA Estimation"])).toBe("Earnings tag");
    expect(naturalLabel("stock split", [])).toBe("Stock split");
  });
});

describe("moving and removing projects", () => {
  it("moves several items at once, as your own filings, and leaves them there", async () => {
    const { store, u, add } = await setup();
    createTypedNote(project, "Chart alerts", "2026-11-26", dir);
    createTypedNote(project, "Dubai move", "2026-11-26", dir);
    await add("Filler", filler.map((f) => f.text));
    await add("Alerts", ["Share the chart alerts requirement with Jay", "Fix the chart alerts colour bug"]);
    await autoFileProjects(store, u.id);
    const before = [...(await byText(store, u.id)).values()].filter((i) => i.project === "chart-alerts");
    expect(before).toHaveLength(2);
    expect(await recordFilings(store, u.id, before.map((i) => ({ ...i })), "dubai-move", AT)).toBe(2);
    const after = await byText(store, u.id);
    expect(after.get("Share the chart alerts requirement with Jay")).toMatchObject({ project: "dubai-move", projectBy: "you" });
    expect(after.get("Fix the chart alerts colour bug")).toMatchObject({ project: "dubai-move", projectBy: "you" });
    expect(readExamples().find((e) => e.text === "Fix the chart alerts colour bug")).toMatchObject({ project: "dubai-move", not: ["chart-alerts"] });
    // And out of any project.
    await recordFilings(store, u.id, [after.get("Fix the chart alerts colour bug")!], null, AT);
    expect((await byText(store, u.id)).get("Fix the chart alerts colour bug")).toMatchObject({ project: null, projectBy: "you" });
  });

  it("removing a project sends its items back to Needs a project and archives it", async () => {
    const { store, u, add } = await setup();
    createTypedNote(project, "Chart alerts", "2026-11-26", dir);
    await add("Filler", filler.map((f) => f.text));
    await add("Alerts", ["Share the chart alerts requirement with Jay", "Fix the chart alerts colour bug"]);
    await autoFileProjects(store, u.id);
    const one = (await byText(store, u.id)).get("Fix the chart alerts colour bug")!;
    await recordFiling(store, u.id, { ...one }, "chart-alerts", AT);
    expect(await removeProject(store, u.id, "chart-alerts")).toBe(2);
    for (const i of (await byText(store, u.id)).values()) expect(i.project ?? null).toBeNull();
    expect(projectRows().find((p) => p.slug === "chart-alerts")?.props.status).toBe("archived");
    expect(readExamples().some((e) => e.project === "chart-alerts")).toBe(false);
    // Archived: a new matching item isn't filed into it.
    await add("More", ["Ship the chart alerts v2"]);
    await autoFileProjects(store, u.id);
    expect((await byText(store, u.id)).get("Ship the chart alerts v2")?.project ?? null).toBeNull();
  });

  it("Undo right after making a project deletes its note", async () => {
    const { store, u, add } = await setup();
    createTypedNote(project, "Chart alerts", "2026-11-26", dir);
    await add("Filler", filler.map((f) => f.text));
    await add("Alerts", ["Share the chart alerts requirement with Jay"]);
    await autoFileProjects(store, u.id);
    await removeProject(store, u.id, "chart-alerts", { deleteNote: true });
    expect(projectRows().some((p) => p.slug === "chart-alerts")).toBe(false);
    expect((await byText(store, u.id)).get("Share the chart alerts requirement with Jay")?.project ?? null).toBeNull();
  });
});

describe("preview before making a project", () => {
  it("shows what a project would take, without making it or filing anything", async () => {
    const { store, u, add } = await setup();
    createTypedNote(project, "Corporate actions", "2026-11-26", dir);
    await add("Filler", filler.map((f) => f.text));
    await add("Alerts", ["Share the chart alerts requirement with Jay", "Split the chart alerts scope into phases", "Book the team lunch"]);
    await autoFileProjects(store, u.id);
    const p = await previewProject(store, u.id, "Chart alerts");
    expect(p.total).toBe(2);
    expect(p.items.map((i) => i.text).sort()).toEqual(["Share the chart alerts requirement with Jay", "Split the chart alerts scope into phases"]);
    expect(projectRows().some((r) => r.slug === "chart-alerts")).toBe(false);
    for (const i of (await byText(store, u.id)).values()) expect(i.project ?? null).toBeNull();
  });
});
