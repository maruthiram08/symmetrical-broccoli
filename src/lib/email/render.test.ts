import { describe, expect, it } from "vitest";
import { escapeHtml, renderEmail } from "./render";
import { fixtureBrief, fixtureLinks, fixtureVariant } from "./fixture";
import type { BriefModel } from "@/lib/types";

const render = (m: BriefModel = fixtureBrief) => renderEmail(m, fixtureLinks);
/** Visible text of the HTML, roughly: tags stripped, entities decoded. */
const visible = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<title>[\s\S]*?<\/title>/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&middot;/g, "·")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("renderEmail: full day", () => {
  const out = render();
  const v = visible(out.html);

  it("uses the model subject", () => {
    expect(out.subject).toBe(fixtureBrief.subject);
  });

  it("starts with the date title and the meetings line", () => {
    expect(v).toContain("Wednesday, 25 November");
    expect(v).toContain("From 4 meetings today");
    expect(v.indexOf("Wednesday, 25 November")).toBeLessThan(v.indexOf("From 4 meetings today"));
  });

  it("shows the evening wrap with kept on lime and late in overdue red", () => {
    expect(v).toMatch(/4 Meetings 4 Promises made 1 Kept 1 Late/);
    expect(out.html).toMatch(/background-color:#d6ff3d;[^"]*"><div class="em-on-hl"[^>]*>1<\/div><div[^>]*>Kept/);
    expect(out.html).toMatch(/class="em-late" style="[^"]*color:#c4320a;[^"]*">1<\/div><div[^>]*>Late/);
  });

  it("renders sections in order", () => {
    const order = ["You owe", "Waiting on", "Decisions", "Closed today", "Download my notes"].map((s) => v.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(v).not.toContain("Still open from before");
  });

  it("puts the overdue item first with its lateness in mono red", () => {
    expect(v.indexOf("Send Nitin the final banner text")).toBeLessThan(v.indexOf("Share dividend UI notes with Prajwal"));
    expect(out.html).toMatch(/class="em-late" style="[^"]*Geist Mono[^"]*color:#c4320a;[^"]*">4h late<\/span>/);
    expect(out.html).toContain("background-color:#c4320a;border-radius:3px"); // red square mark
  });

  it("bolds the person, with a lime fill only in You owe", () => {
    expect(out.html).toMatch(/Send <b class="em-hl" style="[^"]*background-color:#d6ff3d[^"]*">Nitin<\/b> the final banner text/);
    expect(out.html).toMatch(/<b style="font-weight:600;">Tarun<\/b> to confirm the corporate actions config/);
  });

  it("shows quote lines and due labels", () => {
    expect(v).toContain(`"I'll send it in half an hour" · Dividend banner, 1:51 PM`);
    expect(v).toContain(`"Let me check with the data team and come back" · Corporate actions, 6:10 PM`);
    expect(v).toContain("Tomorrow");
    expect(v).toContain("Today");
  });

  it("shows closed items struck through with the closing quote", () => {
    expect(out.html).toMatch(/text-decoration:line-through;">Tarun to check the release timeline<\/span>/);
    expect(v).toContain(`Closed: Tarun said "timeline is fine for Friday" in Dividend implementation, 4:35 PM.`);
  });

  it("names the closer when the line carries a person", () => {
    const m = structuredClone(fixtureBrief);
    Object.assign(m.closedToday[0], { person: "Tarun" });
    expect(visible(render(m).html)).toContain(`Closed: Tarun said "timeline is fine for Friday" in Dividend implementation, 4:35 PM.`);
  });

  it("links Done and Wrong for each open item, Wrong only for decisions", () => {
    for (const id of ["item-banner", "item-ui-notes", "item-ca-config"]) {
      expect(out.html).toContain(`href="https://brief.example.com/a/${id}.done"`);
      expect(out.html).toContain(`href="https://brief.example.com/a/${id}.wrong"`);
    }
    expect(out.html).toContain(`href="https://brief.example.com/a/item-record-date.wrong"`);
    expect(out.html).not.toContain(`item-record-date.done`);
    expect(out.html).not.toContain(`item-timeline.done`);
    expect(out.html).toContain(`href="https://brief.example.com/a/download-token"`);
    expect(out.html).toContain(`href="https://brief.example.com/a/delete-token"`);
  });

  it("stays email-safe", () => {
    expect(out.html).toContain('<meta name="color-scheme" content="light dark">');
    expect(out.html).toContain("max-width:600px");
    expect(out.html).not.toMatch(/<script/i);
    expect(out.html).not.toMatch(/<img/i);
    expect(v).not.toContain("!"); // no exclamation marks in copy
    expect(out.text).not.toContain("!");
  });

  it("builds a plain-text version with the same content and links", () => {
    const t = out.text;
    expect(t.startsWith("Wednesday, 25 November\nFrom 4 meetings today")).toBe(true);
    expect(t).toContain("4 meetings · 4 promises made · 1 kept · 1 late");
    expect(t).toContain("You owe (2 open)");
    expect(t).toContain("- Send Nitin the final banner text (4h late)");
    expect(t).toContain(`  "I'll send it in half an hour" · Dividend banner, 1:51 PM`);
    expect(t).toContain("  Done: https://brief.example.com/a/item-banner.done");
    expect(t).toContain("  Wrong: https://brief.example.com/a/item-banner.wrong");
    expect(t).toContain("Waiting on (1 open)");
    expect(t).toContain("Decisions (1 today)");
    expect(t).toContain(`Closed: Tarun said "timeline is fine for Friday" in Dividend implementation, 4:35 PM.`);
    expect(t).toContain("Download my notes: https://brief.example.com/a/download-token");
    expect(t).toContain("Delete my data: https://brief.example.com/a/delete-token");
    expect(t).not.toMatch(/<[a-z]/i);
  });
});

describe("renderEmail: escaping", () => {
  it("escapes every piece of user and transcript text", () => {
    const m = structuredClone(fixtureBrief);
    const evil = `<script>alert("x")</script> & 'q'`;
    m.dateLabel = evil;
    m.subject = evil;
    m.youOwe[0].text = `Send <b>Nitin</b> the "text" & <img src=x onerror=1>`;
    m.youOwe[0].quote = evil;
    m.youOwe[0].meetingTitle = "<i>Banner</i>";
    m.waitingOn[0].person = "<Tarun>";
    m.waitingOn[0].text = "<Tarun> to confirm";
    m.decisions[0].text = evil;
    m.closedToday[0].closeQuote = `"><svg onload=1>`;
    m.closedToday[0].closedInMeeting = "<u>Standup</u>";
    m.youOwe[0].lateLabel = "<4h>";
    const { html } = render(m);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<i>Banner");
    expect(html).not.toContain("<u>Standup");
    expect(html).not.toContain("<Tarun>");
    expect(html).not.toContain("<4h>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&lt;Tarun&gt;");
    expect(html).toMatch(/<title>&lt;script&gt;/);
  });

  it("refuses non-http link schemes", () => {
    const { html } = renderEmail(fixtureBrief, { ...fixtureLinks, deleteUrl: "javascript:alert(1)", actionUrl: () => `https://x.test/a/"><b>` });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain(`"><b>`);
    expect(html).toContain("https://x.test/a/&quot;&gt;&lt;b&gt;");
  });

  it("escapeHtml covers the five characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});

describe("renderEmail: sections and empty states", () => {
  it("omits empty sections", () => {
    const m = structuredClone(fixtureBrief);
    m.waitingOn = [];
    m.decisions = [];
    m.closedToday = [];
    const v = visible(render(m).html);
    expect(v).toContain("You owe");
    expect(v).not.toContain("Waiting on");
    expect(v).not.toContain("Decisions");
    expect(v).not.toContain("Closed today");
  });

  it("nothing_owed shows the big line and keeps other sections", () => {
    const { html, text } = render(fixtureVariant("nothing_owed"));
    const v = visible(html);
    expect(v).toContain("Nothing owed. Go home.");
    expect(html).toMatch(/font-size:32px;[^"]*">Nothing owed\. Go home\.<\/div>/);
    expect(v).not.toContain("You owe");
    expect(v).toContain("Waiting on");
    expect(text).toContain("Nothing owed. Go home.");
  });

  it("no_meetings shows the open count and no wrap", () => {
    const { html, text } = render(fixtureVariant("no_meetings"));
    const v = visible(html);
    expect(v).toContain("No meetings today. 3 items still open.");
    expect(v).not.toContain("From 0 meetings");
    expect(v).not.toContain("Promises made");
    expect(v).toContain("Still open from before 3 items");
    expect(v).toContain("2d late");
    expect(text).toContain("No meetings today. 3 items still open.");
  });

  it("singular forms read naturally", () => {
    const m = fixtureVariant("no_meetings");
    m.stillOpenCount = 1;
    m.stillOpen = m.stillOpen.slice(0, 1);
    const v = visible(render(m).html);
    expect(v).toContain("No meetings today. 1 item still open.");
    const one = { ...structuredClone(fixtureBrief), meetingCount: 1 };
    expect(visible(render(one).html)).toContain("From 1 meeting today");
  });

  it("lists at most 5 still-open items and counts the rest", () => {
    const { html, text } = render(fixtureVariant("still_open"));
    const v = visible(html);
    expect(v).toContain("Still open from before 7 items");
    expect(v).toContain("Tarun to send the old report 5");
    expect(v).toContain("And 2 more.");
    expect(text).toContain("Still open from before (7 items)");
    expect(text).toContain("And 2 more.");
  });
});
