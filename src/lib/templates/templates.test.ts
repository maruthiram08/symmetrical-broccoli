import { describe, expect, it } from "vitest";
import { renderMarkdown } from "@/lib/brief/markdown";
import { renderWeekMarkdown, type WeekModel } from "@/lib/brief/week";
import type { BriefModel } from "@/lib/types";
import { renderDaily, renderDecisionsLines } from "./daily";
import { renderTemplate, TemplateError, templateProblem } from "./engine";
import { renderSample, SAMPLE_BRIEF, SAMPLE_MEETING, SAMPLE_WEEK, TEMPLATE_INFO, TEMPLATE_KINDS } from "./kinds";
import { linkContext, linkMention, noteName, wikilink } from "./links";
import { renderMeetingNote, renderPersonPage } from "./meeting";
import { renderWeek } from "./week";
import { renderDecisionsAppend } from "@/lib/brief/markdown";

describe("template engine", () => {
  it("fills fields, ifs, unless, each with @index, else and nested scopes", () => {
    const t = "Hi {{name}}{{#if vip}} ★{{/if}}\n{{#each xs}}{{@number}}. {{label}} of {{name}}\n{{else}}none\n{{/each}}{{#unless xs}}empty{{/unless}}";
    expect(renderTemplate(t, { name: "Asha", vip: true, xs: [{ label: "a" }, { label: "b" }] })).toBe("Hi Asha ★\n1. a of Asha\n2. b of Asha\n");
    expect(renderTemplate(t, { name: "Asha", vip: false, xs: [] })).toBe("Hi Asha\nnone\nempty");
  });

  it("drops lines that hold only a block tag, keeps inline ones", () => {
    expect(renderTemplate("a\n  {{#if x}}\nb\n{{/if}}\nc\n", { x: true })).toBe("a\nb\nc\n");
    expect(renderTemplate("a {{#if x}}b{{/if}} c", { x: false })).toBe("a  c");
    expect(renderTemplate("{{! note }}\nx\n", {})).toBe("x\n");
  });

  it("explains broken templates with a line number", () => {
    expect(() => renderTemplate("ok\n{{#if a}}\nno close", {})).toThrow(TemplateError);
    expect(templateProblem("ok\n{{#if a}}\nno close")).toMatch(/^Line 2: .*never closed/);
    expect(templateProblem("{{/each}}")).toMatch(/closes nothing/);
    expect(templateProblem("{{#if a}}{{/each}}")).toMatch(/expected/);
    expect(templateProblem("{{#loop a}}{{/loop}}")).toMatch(/unknown block/);
    expect(templateProblem("{{ not a field }}")).toMatch(/isn't a field/);
    expect(templateProblem(TEMPLATE_INFO.daily.defaults)).toBeNull();
  });

  it("never runs code or reaches outside the data", () => {
    expect(renderTemplate("{{constructor}}{{__proto__}}{{toString}}", {})).toBe("");
  });
});

const base = SAMPLE_BRIEF;
const variants: Array<[string, BriefModel]> = [
  ["sample", base],
  ["no meetings", { ...base, meetingCount: 0, youOwe: [], waitingOn: [], decisions: [], closedToday: [], stillOpen: [], stillOpenCount: 0, empty: "no_meetings", tomorrow: undefined, openPromises: undefined }],
  ["nothing owed", { ...base, meetingCount: 1, youOwe: [], empty: "nothing_owed", stillOpenCount: 0, stillOpen: [] }],
  ["one meeting, all shown", { ...base, meetingCount: 1, stillOpenCount: 1, tomorrow: [], waitingOn: [{ ...base.waitingOn[0], shared: true }] }],
  ["markdown in text", { ...base, youOwe: [{ ...base.youOwe[0], text: "Fix *bold* [link] #tag\nnext", quote: "a|b `c`" }] }],
];

describe("default templates reproduce the notes exactly", () => {
  for (const [name, m] of variants) {
    it(`daily note: ${name}`, () => {
      expect(renderDaily(m)).toBe(renderMarkdown(m));
    });
  }

  it("daily note snapshot", () => {
    expect(renderDaily(base)).toMatchSnapshot();
  });

  const weeks: Array<[string, WeekModel]> = [
    ["sample", SAMPLE_WEEK],
    ["quiet week", { ...SAMPLE_WEEK, counts: { meetings: 1, made: 1, kept: 0, late: 0 }, youOwe: [], oweYou: [], decisions: [], stale: [] }],
    ["only closed", { ...SAMPLE_WEEK, youOwe: [{ person: "Nitin", total: 2, open: 0 }], stale: [{ ...SAMPLE_WEEK.stale[0], quote: "", kind: "owe" }] }],
  ];
  for (const [name, w] of weeks) {
    it(`weekly recap: ${name}`, () => {
      expect(renderWeek(w)).toBe(renderWeekMarkdown(w));
    });
  }

  it("decisions.md lines without links are unchanged", () => {
    expect(renderDecisionsLines(base)).toBe(renderDecisionsAppend(base));
  });

  it("meeting note snapshot", () => {
    expect(renderMeetingNote(SAMPLE_MEETING)).toMatchSnapshot();
  });

  it("every kind renders its sample, with and without links", () => {
    for (const k of TEMPLATE_KINDS) {
      expect(renderSample(k, TEMPLATE_INFO[k].defaults, false).length).toBeGreaterThan(50);
      expect(renderSample(k, TEMPLATE_INFO[k].defaults, true)).toContain("[[");
    }
  });

  it("a user template changes the note", () => {
    expect(renderDaily(base, { template: "# {{dateLabel}}\n{{#each youOwe}}* {{text}}\n{{/each}}" })).toBe(
      "# Thursday, 26 November\n* Share the Q4 plan with Priya\n* Send Nitin the final banner text\n* Book the venue\n",
    );
  });
});

describe("automatic links", () => {
  const links = linkContext({ names: ["Nitin", "nitin", "Priya K", "Priya", "Maruthi"], self: ["Maruthi"], meetings: new Map([["m1", "2026-11-26 Growth standup"]]) });

  it("one page per person, never you", () => {
    expect(links.person("nitin")).toBe("Nitin");
    expect(links.person("Priya")).toBe("Priya K");
    expect(links.person("Maruthi")).toBeNull();
    expect(links.person(null)).toBeNull();
  });

  it("links people, meetings and decisions in the daily note", () => {
    const md = renderDaily(base, { links });
    expect(md).toContain("- [ ] ★ Send [[Nitin]] the final banner text (Fri)");
    expect(md).toContain('· [[2026-11-26 Growth standup|Growth standup]], 10:30 AM');
    expect(md).toContain("Share the Q4 plan with [[Priya K|Priya]]");
    expect(md).toContain("[[decisions#^d-d1|decision log]]");
    // Waiting item names Tarun in the text
    expect(md).toContain("[[Tarun]] to send the API spec");
    // Same note otherwise: links only add, so stripping them gives back today's note
    const unlink = (s: string) => s.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/ · decisions#\^d-\w+/g, "");
    expect(unlink(md).split("\n").length).toBe(renderMarkdown(base).split("\n").length);
  });

  it("names a person under the line when the text doesn't", () => {
    const m = { ...base, youOwe: [{ ...base.youOwe[1], text: "Send the banner text", starred: false }] };
    expect(renderDaily(m, { links })).toContain('"I\'ll send you the banner copy by Friday" · [[2026-11-26 Growth standup|Growth standup]], 10:30 AM · [[Nitin]]');
  });

  it("decisions.md lines link the day and the meeting and carry a block id", () => {
    expect(renderDecisionsLines(base, links)).toBe(
      '- [[2026-11-26]] · Ship the dividend banner on Friday — "Let\'s just ship it Friday" ([[2026-11-26 Growth standup|Growth standup]], 10:30 AM) ^d-d1\n',
    );
  });

  it("links people in the weekly recap and meeting notes", () => {
    expect(renderWeek(SAMPLE_WEEK, { links })).toContain("- [[Nitin]]: 2 open, 1 closed");
    const note = renderMeetingNote(SAMPLE_MEETING, { links });
    expect(note).toContain("[[2026-11-26]], 10:30 AM · with [[Nitin]], [[Priya K|Priya]]");
    expect(note).not.toContain("you@example.com");
  });

  it("safe names and mentions", () => {
    expect(noteName('a/b:c*?"<>|#^[x]')).toBe("a b c x");
    expect(noteName("...")).toBe("Untitled");
    expect(wikilink("Nitin", "nitin")).toBe("[[Nitin|nitin]]");
    expect(linkMention("Ask Nitinder, then Nitin", "Nitin", "Nitin", "Nitin").text).toBe("Ask Nitinder, then [[Nitin]]");
    expect(linkMention("No one", "Nitin", "Nitin", "Nitin").linked).toBe(false);
  });

  it("person pages list what's open with them", () => {
    const md = renderPersonPage({
      name: "Nitin", items: SAMPLE_MEETING.items.filter((i) => i.person === "Nitin"), meetings: new Map([["m1", SAMPLE_MEETING.meeting]]),
      timeZone: "Asia/Kolkata", now: SAMPLE_MEETING.now, links,
    });
    expect(md).toContain("# Nitin");
    expect(md).toContain("## You owe Nitin");
    expect(md).toContain("[[2026-11-26 Growth standup|Growth standup, 2026-11-26]]");
  });
});
