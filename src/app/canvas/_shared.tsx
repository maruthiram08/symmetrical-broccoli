import Link from "next/link";
import type { ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { DetailBar, LinkGroups, ListBar, type LinkGroup } from "@/components/reading/Frame";
import type { User } from "@/lib/types";

export type BoardKey = "home" | "week" | "prep" | "map" | "combine" | "start";

const BOARDS: Array<{ key: Exclude<BoardKey, "home">; title: string; sub: string; badge: string; href: string }> = [
  { key: "week", title: "This week", sub: "Every meeting this week, with what came out of it", badge: "Board", href: "/canvas/week" },
  { key: "prep", title: "Meeting prep", sub: "Your last meetings and everything open, before the next one", badge: "Pick one", href: "/canvas?pick=prep" },
  { key: "map", title: "Map of a topic", sub: "One topic across every meeting, like corporate action", badge: "Pick one", href: "/canvas?pick=map" },
  { key: "combine", title: "Two meetings side by side", sub: "Spot where they disagree", badge: "Pick two", href: "/canvas?pick=combine" },
  { key: "start", title: "Start from an item", sub: "Everything around one promise, ready to hand to Claude", badge: "Pick one", href: "/canvas?pick=start" },
];

/** The boards, for the list pane. */
export function CanvasList({ sel }: { sel: BoardKey }) {
  const groups: LinkGroup[] = [{ key: "boards", label: "Boards", rows: BOARDS.map((b) => ({ key: b.key, href: b.href, title: b.title, sub: b.sub, badge: b.badge, mark: "sq", bold: true })) }];
  return (
    <>
      <ListBar title="Canvas" count="Builds itself from meetings" />
      <LinkGroups groups={groups} sel={sel === "home" ? null : sel} foot="Boards fill and update by themselves from what was said. Drag cards to arrange them; the content stays live." />
    </>
  );
}

/** The page frame every canvas view shares: the boards in the list, the board full width on the right. */
export async function CanvasFrame({ title, sub, children, board = "week", acts }: { user?: User; title: string; sub?: string; children: ReactNode; board?: BoardKey; acts?: ReactNode }) {
  const b = BOARDS.find((x) => x.key === board);
  const detail = (
    <div className="rp-wrap">
      <DetailBar crumb={[{ label: "Canvas", href: "/canvas" }, { label: title }]} listHref="/canvas" acts={acts ?? (b && b.key !== "week" ? <Link className="rp-btn" href={b.href}>Pick another</Link> : null)} />
      <div className="rp-board">
        {sub ? <p className="rp-board__sub">{sub}</p> : null}
        {children}
      </div>
    </div>
  );
  return <Shell current="canvas" list={<CanvasList sel={board} />} detail={detail} show="detail" />;
}
