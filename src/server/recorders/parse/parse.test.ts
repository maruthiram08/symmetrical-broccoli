import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cleanTitle, findDate, parseClock, speakerLabel, titleFromName } from "./common";
import { DocxError, docxToText } from "./docx";
import { looksLikeZoomCaptions, parseCues, parsePlain, parseZoomCaptions } from "./formats";
import { isTranscriptFile, parseTranscriptBytes } from ".";

// Every fixture is synthetic: made-up people and meetings, never a real transcript.
const F = join(__dirname, "..", "fixtures");
const read = (p: string) => readFileSync(join(F, p));
const IST = "Asia/Kolkata";

describe("findDate", () => {
  it("reads Zoom cloud names as UTC", () => {
    expect(findDate("GMT20261122-043000_Recording.transcript.vtt", IST)).toEqual({ iso: "2026-11-22T04:30:00.000Z", hasTime: true });
  });
  it("reads local folder names in the user's zone", () => {
    expect(findDate("2026-11-24 10.00.00 Pricing review", IST)?.iso).toBe("2026-11-24T04:30:00.000Z");
    expect(findDate("2026-11-25 09-15-02", IST)?.iso).toBe("2026-11-25T03:45:02.000Z");
  });
  it("prefers an explicit offset over the zone", () => {
    expect(findDate("Sync (2026-11-24 14:00 GMT+05:30) - Transcript", "America/New_York")?.iso).toBe("2026-11-24T08:30:00.000Z");
    expect(findDate("2026-11-24T14:00 UTC", IST)?.iso).toBe("2026-11-24T14:00:00.000Z");
  });
  it("reads month names and am/pm", () => {
    expect(findDate("Nov 25, 2026 at 6:40 PM", IST)?.iso).toBe("2026-11-25T13:10:00.000Z");
    expect(findDate("25 November 2026, 12:05 am", IST)?.iso).toBe("2026-11-24T18:35:00.000Z");
  });
  it("puts a date with no time at 09:00 local", () => {
    expect(findDate("notes 2026-11-21", IST)).toEqual({ iso: "2026-11-21T03:30:00.000Z", hasTime: false });
  });
  it("ignores impossible dates and text without one", () => {
    expect(findDate("2026-13-45 10:00", IST)).toBeNull();
    expect(findDate("standup", IST)).toBeNull();
  });
});

describe("titles and labels", () => {
  it("cleans file names", () => {
    expect(titleFromName("2026-11-24 10.00.00 Pricing review")).toBe("Pricing review");
    expect(titleFromName("GMT20261122-043000_Recording.transcript.vtt")).toBe("");
    expect(titleFromName("Weekly design sync (2026-11-24 14:00 GMT+05:30) - Transcript.txt")).toBe("Weekly design sync");
    expect(titleFromName("vendor_onboarding.md")).toBe("vendor onboarding");
  });
  it("cleans title lines", () => {
    expect(cleanTitle("# Vendor onboarding")).toBe("Vendor onboarding");
    expect(cleanTitle("Weekly design sync (2026-11-24 14:00 GMT+05:30) - Transcript")).toBe("Weekly design sync");
  });
  it("tells speaker labels from sentences", () => {
    expect(speakerLabel("Asha Rao")).toBe("Asha Rao");
    expect(speakerLabel("Speaker 2")).toBe("Speaker 2");
    expect(speakerLabel("the plan for today is")).toBeNull();
    expect(speakerLabel("Note")).toBeNull();
    expect(speakerLabel("Well, honestly")).toBeNull();
  });
  it("parses clocks", () => {
    expect(parseClock("01:02:03.500")).toBe(3723.5);
    expect(parseClock("02:03,5")).toBe(123.5);
    expect(parseClock("hello")).toBeNull();
  });
});

describe("WebVTT and SRT", () => {
  it("reads a Zoom .vtt with Name: prefixes and carries the speaker across cues", () => {
    const p = parseCues(read("zoom/2026-11-24 10.00.00 Pricing review/audio_transcript.vtt").toString());
    expect(p.text.split("\n")).toEqual([
      "Asha Rao: Morning everyone, let's look at the pricing page.",
      "Test User: I'll send the revised tiers to Ravi by Friday. and copy finance on it.",
      "Ravi Kumar: Great, I'll review them on Monday.",
    ]);
    expect(p.speakers).toEqual(["Asha Rao", "Test User", "Ravi Kumar"]);
    expect(p.durationSec).toBe(2529);
  });
  it("reads <v> voice tags", () => {
    const p = parseCues(read("zoom/GMT20261122-043000_Recording.transcript.vtt").toString());
    expect(p.text).toBe("Meera Iyer: Quick check on the hiring plan.\nTest User: We decided to open two roles in January. I'll write the job posts.");
  });
  it("reads SRT with comma timings", () => {
    const p = parseTranscriptBytes("standup.srt", read("inbox/standup.srt"), IST);
    expect(p.text).toBe("Meera Iyer: Yesterday I fixed the export bug.\nTest User: I'm waiting on the API keys from Ravi.");
    expect(p.durationSec).toBe(5);
  });
  it("survives CRLF, a BOM and an empty file", () => {
    expect(parseCues("﻿WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nAsha: hi\r\n").text).toBe("Asha: hi");
    expect(parseCues("").text).toBe("");
  });
});

describe("Zoom saved captions", () => {
  it("reads the [Name] HH:MM:SS layout and gives the first clock", () => {
    const raw = read("zoom/2026-11-23 15.30.00 Asha Rao's Zoom Meeting/meeting_saved_closed_caption.txt").toString();
    expect(looksLikeZoomCaptions(raw)).toBe(true);
    const p = parseZoomCaptions(raw);
    expect(p.firstClock).toBe("15:31:05");
    expect(p.text.split("\n")[1]).toBe("Test User: Yes, I'll share it after this call.");
    expect(p.durationSec).toBe(27 * 60 + 35);
  });
  it("reads the older 'HH:MM:SS From Name : text' layout", () => {
    const p = parseZoomCaptions("10:02:13 From Asha Rao : Can we ship Friday?\n10:02:20 From Test User : Yes, I'll confirm today.\n");
    expect(p.text).toBe("Asha Rao: Can we ship Friday?\nTest User: Yes, I'll confirm today.");
  });
});

describe("plain text and Markdown", () => {
  it("reads a Google Meet transcript: title, time, attendees and speech, without the footer", () => {
    const p = parseTranscriptBytes("x.txt", read("inbox/Weekly design sync (2026-11-24 14:00 GMT+05:30) - Transcript.txt"), IST);
    expect(p.title).toBe("Weekly design sync");
    expect(p.startedAt).toBe("2026-11-24T08:30:00.000Z");
    expect(p.looksLikeMeet).toBe(true);
    expect(p.speakers).toEqual(["Asha Rao", "Meera Iyer", "Test User"]);
    expect(p.text).not.toMatch(/Transcript ended|computer generated/);
  });
  it("reads a phone-call note with a date line and Me:", () => {
    const p = parseTranscriptBytes("Call with Ravi.txt", read("inbox/Call with Ravi.txt"), IST);
    expect(p.title).toBe("Call with Ravi");
    expect(p.startedAt).toBe("2026-11-25T13:10:00.000Z");
    expect(p.looksLikePhone).toBe(true);
    expect(p.text).toContain("Me: Not yet, I'll read it tonight");
  });
  it("keeps unlabelled speech and doesn't take it for a title", () => {
    const p = parseTranscriptBytes("x.txt", read("inbox/phone/2026-11-25 09-15-02.txt"), IST);
    expect(p.title).toBeNull();
    expect(p.speakers).toEqual([]);
    expect(p.text).toContain("transfer the deposit");
  });
  it("reads a Markdown heading, a Date: line and **bold** speakers", () => {
    const p = parseTranscriptBytes("vendor-notes.md", read("inbox/vendor-notes.md"), IST);
    expect(p.title).toBe("Vendor onboarding");
    expect(p.startedAt).toBe("2026-11-21T05:30:00.000Z");
    expect(p.text).toBe("Asha Rao: We need the signed NDA before the kickoff.\nTest User: I'll get legal to sign it this week.");
  });
  it("reads timestamped line shapes", () => {
    const p = parsePlain("[00:00:05] Asha: one\n00:00:09 Ravi: two\nMeera (00:01:00): three\nAsha Rao 00:02:00\nfour\n", IST);
    expect(p.text.split("\n")).toEqual(["Asha: one", "Ravi: two", "Meera: three", "Asha Rao: four"]);
    expect(p.durationSec).toBe(115);
  });
});

describe("docx", () => {
  it("reads a Google Docs download (deflated) as a Meet transcript", () => {
    const p = parseTranscriptBytes("Product roadmap review.docx", read("inbox/Product roadmap review.docx"), IST);
    expect(p.title).toBe("Product roadmap review");
    expect(p.startedAt).toBe("2026-11-20T11:00:00.000Z");
    expect(p.text.split("\n")).toEqual([
      "Asha Rao: Ravi, can you send the Q1 roadmap draft & the budget?",
      "Ravi Kumar: Yes, I’ll send both by Monday.",
      "Asha Rao: We decided to ship mobile first.",
    ]);
    expect(p.text).not.toContain("deleted words");
  });
  it("reads a stored (uncompressed) zip", () => {
    expect(docxToText(read("stored.docx"))).toContain("We decided to ship mobile first.");
  });
  it("throws DocxError on something that isn't a docx", () => {
    expect(() => docxToText(read("not-a.docx"))).toThrow(DocxError);
    expect(() => docxToText(Buffer.from("hello"))).toThrow(DocxError);
  });
});

describe("isTranscriptFile", () => {
  it("accepts transcript types and skips hidden and Office lock files", () => {
    expect(["a.vtt", "a.SRT", "a.txt", "a.md", "a.docx"].every(isTranscriptFile)).toBe(true);
    expect(["a.mp4", ".DS_Store", "~$a.docx", "a.pdf"].some(isTranscriptFile)).toBe(false);
  });
});
