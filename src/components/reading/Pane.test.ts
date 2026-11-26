import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { Group, Row } from "@/lib/reading/model";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/open" }));
vi.mock("next/link", () => ({
  default: (props: Record<string, unknown>) => {
    const { href, children, ...rest } = props;
    delete rest.replace;
    delete rest.scroll;
    return h("a", { href, ...rest }, children as never);
  },
}));
vi.mock("@/app/actions", () => ({ setStatus: vi.fn() }));
vi.mock("../QuickCapture", () => ({ OPEN_CAPTURE: "db:capture" }));

const { ReadingProvider, ListGroups, DetailNav } = await import("./Pane");

const row = (id: string, o: Partial<Row> = {}): Row => ({
  id, kind: "owe", status: "open", mark: "owe", title: `Title ${id}`, quote: `Quote ${id}`, meta: "Jit · Sprint · 2 Nov", badge: "24d", late: false, done: false, ...o,
});
const groups: Group[] = [
  { key: "late", label: "Late", short: "Late", late: true, rows: [row("a", { mark: "late", late: true, badge: "24d late" })] },
  { key: "now", label: "Open now", short: "Now", rows: ["1", "2", "3", "4", "5", "6", "7", "8"].map((x) => row(x)) },
  { key: "kept", label: "Kept today", short: "Kept", rows: [], empty: "Nothing kept yet today." },
];
const ids = groups.map((g) => ({ key: g.key, ids: g.rows.map((r) => r.id) }));
const render = (selected: string | null, auto = false, extra?: unknown) =>
  renderToStaticMarkup(h(ReadingProvider, { groups: ids, param: "item", selected, auto, children: [h(ListGroups, { key: "l", groups, hrefBase: "/open" }), extra as never] }));

describe("the list pane", () => {
  it("renders each row: the Done mark, title, quote, meta and badge, linked by ?item=", () => {
    const html = render(null);
    expect(html).toContain('aria-label="Mark done"');
    expect(html).toContain('class="rp-m rp-m--late"');
    expect(html).toContain('href="/open?item=a"');
    expect(html).toContain("Title a");
    expect(html).toContain("&ldquo;Quote a&rdquo;".replace(/&ldquo;|&rdquo;/g, (m) => (m === "&ldquo;" ? "“" : "”")));
    expect(html).toContain("Jit · Sprint · 2 Nov");
    expect(html).toContain('class="rp-badge rp-badge--late">24d late');
    expect(html).not.toContain("db-act"); // no hover pills
  });
  it("has a jump chip and a sticky header per group, and empty text for an empty group", () => {
    const html = render(null);
    expect(html).toContain('href="#rp-g-now"><b>8</b>Now');
    expect(html).toContain('class="rp-gh rp-gh--late" id="rp-g-late"');
    expect(html).toContain("Nothing kept yet today.");
  });
  it("shows six rows of a long group, then Show N more", () => {
    const html = render(null);
    expect(html).toContain("Title 6");
    expect(html).not.toContain("Title 7");
    expect(html).toContain("Show 2 more");
  });
  it("opens the group when the selected row sits behind Show more", () => {
    const html = render("8");
    expect(html).toContain("Title 8");
    expect(html).toContain("Show less");
    expect(html).toMatch(/class="rp-row rp-row--sel"[^>]*data-rp-row="8"/);
  });
  it("marks the selected row and shows the detail on phones only when you picked it", () => {
    expect(render("2")).toContain('data-show="detail"');
    expect(render("2", true)).toContain('data-show="list"');
    expect(render(null)).toContain('data-show="list"');
  });
  it("counts the selection among the visible rows: N of M", () => {
    const html = render("2", false, h(DetailNav, { id: "2" }));
    expect(html).toContain("3 of 7");
  });
  it("shows done rows struck through with Mark open", () => {
    const html = renderToStaticMarkup(h(ReadingProvider, { groups: [{ key: "k", ids: ["d"] }], param: "item", selected: null,
      children: h(ListGroups, { groups: [{ key: "k", label: "Kept", short: "Kept", rows: [row("d", { done: true, mark: "done", status: "done" })] }], hrefBase: "/" }) }));
    expect(html).toContain("rp-row--done");
    expect(html).toContain('aria-label="Mark open"');
    expect(html).toContain('href="/?item=d"');
  });
});
