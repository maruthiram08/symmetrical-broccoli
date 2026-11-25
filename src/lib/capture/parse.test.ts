import { describe, expect, it } from "vitest";
import { parseCapture, parseDue } from "./parse";

// Wednesday 25 Nov 2026, 11:00 in Kolkata.
const now = new Date("2026-11-25T05:30:00Z");
const ctx = { people: ["Nitin K", "Tarun", "Priya", "Arjun"], self: ["Maruthi", "Maru"], now, timeZone: "Asia/Kolkata" };
const p = (s: string) => parseCapture(s, ctx);

describe("parseDue", () => {
  const today = "2026-11-25"; // Wednesday
  it.each([
    ["call mom today", "2026-11-25", "call mom"],
    ["send it tonight", "2026-11-25", "send it"],
    ["send it by EOD", "2026-11-25", "send it"],
    ["send it tomorrow", "2026-11-26", "send it"],
    ["send it tmrw", "2026-11-26", "send it"],
    ["send it the day after tomorrow", "2026-11-27", "send it"],
    ["send it by Fri", "2026-11-27", "send it"],
    ["send it on friday", "2026-11-27", "send it"],
    ["send it Mon", "2026-11-30", "send it"],
    ["send it wed", "2026-11-25", "send it"],
    ["send it next wed", "2026-12-02", "send it"],
    ["send it next week", "2026-11-30", "send it"],
    ["send it in 3 days", "2026-11-28", "send it"],
    ["send it by 2026-12-04", "2026-12-04", "send it"],
    ["send it by 3 Dec", "2026-12-03", "send it"],
    ["send it by Dec 3rd", "2026-12-03", "send it"],
    ["send it on the 5th of January", "2027-01-05", "send it"],
    ["send it 1 Nov", "2027-11-01", "send it"],
    ["send it end of week", "2026-11-27", "send it"],
  ])("%s", (input, date, rest) => {
    expect(parseDue(input, today)).toEqual({ date, rest });
  });
  it("leaves words that only look like days alone", () => {
    expect(parseDue("plan the wedding", today)).toEqual({ date: null, rest: "plan the wedding" });
    expect(parseDue("we may ship", today)).toEqual({ date: null, rest: "we may ship" });
    expect(parseDue("send 31 Feb notes", today).date).toBeNull();
  });
});

describe("parseCapture", () => {
  it("reads something you owe, with a known person and a weekday", () => {
    expect(p("send Nitin the deck by Fri")).toEqual({
      kind: "owe", text: "Send Nitin the deck", person: "Nitin K", dueDate: "2026-11-27", dueAt: "2026-11-27T12:30:00.000Z",
    });
  });
  it("reads someone who owes you", () => {
    expect(p("Tarun owes me API spec tomorrow")).toEqual({
      kind: "waiting", text: "Tarun to send API spec", person: "Tarun", dueDate: "2026-11-26", dueAt: "2026-11-26T12:30:00.000Z",
    });
    expect(p("tarun owes me the review of the doc")).toMatchObject({ kind: "waiting", person: "Tarun", text: "Tarun to send the review of the doc" });
  });
  it("reads other waiting phrasings", () => {
    expect(p("waiting on Priya for the brand tokens")).toMatchObject({ kind: "waiting", person: "Priya", text: "Priya to send the brand tokens" });
    expect(p("waiting for Arjun to review the FAQ by Mon")).toMatchObject({ kind: "waiting", person: "Arjun", text: "Arjun to review the FAQ", dueDate: "2026-11-30" });
    expect(p("Priya will share the colour tokens")).toMatchObject({ kind: "waiting", person: "Priya", text: "Priya to share the colour tokens" });
    expect(p("Leela to send the research notes")).toMatchObject({ kind: "waiting", person: "Leela", text: "Leela to send the research notes" });
    expect(p("get the budget draft from Tarun")).toMatchObject({ kind: "waiting", person: "Tarun", text: "Tarun to send the budget draft" });
    expect(p("waiting: legal sign-off from Ravi")).toMatchObject({ kind: "waiting", person: "Ravi" });
  });
  it("guesses an unknown name from its place in the line", () => {
    expect(p("email Ravi the invoice")).toMatchObject({ kind: "owe", person: "Ravi", text: "Email Ravi the invoice" });
    expect(p("book a table for Meera on Sat")).toMatchObject({ kind: "owe", person: "Meera", dueDate: "2026-11-28" });
  });
  it("keeps the line as typed when there is no person or date", () => {
    expect(p("renew the passport")).toEqual({ kind: "owe", text: "Renew the passport", person: null, dueDate: null, dueAt: null });
    expect(p("I need to renew the passport")).toMatchObject({ text: "Renew the passport" });
  });
  it("never picks you as the other person", () => {
    expect(p("send Maruthi notes")).toMatchObject({ person: null });
  });
  it("uses the known spelling", () => {
    expect(p("share the plan with priya")).toMatchObject({ person: "Priya", text: "Share the plan with Priya" });
  });
});
