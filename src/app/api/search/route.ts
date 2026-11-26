import { NextResponse } from "next/server";
import { listPeople } from "@/lib/people";
import { buildIndex, search } from "@/lib/search";
import { me } from "@/server/local/app";
import { pastDays } from "../../_lib/days";
import { loadAll, shortDate } from "../../_lib/lines";
import { hitHref } from "../../_lib/links";
import { noteSearch } from "../../_lib/vault";

export const dynamic = "force-dynamic";

/** For the command palette: people and past days to jump to, plus the top search results for q. */
export async function GET(req: Request) {
  const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 200);
  const user = await me();
  if (!user) return NextResponse.json({ people: [], days: [], results: [] });
  const { items, meetings, people: dir } = await loadAll(user);
  const people = listPeople({ items, meetings, now: new Date(), self: [user.name, ...user.aliases], people: dir })
    .map((p) => ({ name: p.name, slug: p.slug, youOwe: p.youOwe, theyOwe: p.theyOwe }));
  const results = search(buildIndex(items, meetings), q, 8).map((h) =>
    h.type === "item"
      ? { type: h.type, id: h.id, kind: h.kind, status: h.status, text: h.text, sub: [h.person, h.meetingTitle, shortDate(h.at, user.timeZone)].filter(Boolean).join(" · "), href: hitHref(h) }
      : { type: h.type, id: h.id, kind: "meeting", status: "open", text: h.title, sub: shortDate(h.at, user.timeZone), href: hitHref(h) },
  );
  return NextResponse.json(
    { people, days: await pastDays(user.id, ""), results, ...(await noteSearch(user, q)) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
