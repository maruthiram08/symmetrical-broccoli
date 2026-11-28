// The canvas: five views drawn from your meetings (project map, meeting prep, start in a new window,
// combine threads, Friday review). Builders in build.ts lay nodes out; the board only draws them.
// No imports, so the client bundle stays small.

export type NodeKind = "day" | "meeting" | "owe" | "waiting" | "decision" | "quote" | "person" | "ask" | "window" | "conflict" | "zone" | "more";

/** Buttons on a node. The board calls the matching server action. */
export type NodeAction =
  | { type: "resolve"; contradictionId: string; how: "keep" | "replace"; label: string }
  | { type: "next-week"; itemId: string; label: string }
  | { type: "done"; itemId: string; label: string }
  | { type: "link"; href: string; label: string };

export interface CanvasNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  w: number;
  /** Zones only: their height. */
  h?: number;
  /** Small line above the title: "Meeting · 25 Nov", "You owe Riya · due Fri". */
  label: string;
  title: string;
  sub?: string;
  quote?: string;
  href?: string;
  /** Done items: faded and struck through. */
  done?: boolean;
  /** Zones: "hi" (ink edge), "red" (stuck), "" (quiet). */
  tone?: "hi" | "red" | "";
  itemId?: string;
  meetingId?: string;
  /** Can be fed to the Ask node (meetings and items). */
  context?: boolean;
  /** Cards with the same stack key sit in one column, each under the one before, once measured. */
  stack?: string;
  /** Zones: the stack they hold, so they grow to fit it. */
  holds?: string;
  /** Item cards that can be dragged onto a drop zone. */
  draggable?: boolean;
  /** Zones: dropping an item card here moves it to next week. */
  drop?: "next-week";
  actions?: NodeAction[];
}

/** from: an item came out of a meeting. close: a later meeting closed it. ctx: Ask or a window reads it. conflict: two decisions disagree. soft: related. */
export type EdgeKind = "from" | "close" | "ctx" | "conflict" | "soft";

export interface CanvasEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface CanvasWindow {
  id: string;
  itemId: string;
  kind: "claude" | "claude-code" | "slack" | "email";
  title: string;
  status: "running" | "ready" | "error" | "done";
  output: string;
  createdAt: string;
}

export interface CanvasDoc {
  /** Stable per view and subject, for remembering where you dragged things. */
  id: string;
  title: string;
  meta: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Shown instead of the board when there's nothing to draw. */
  empty?: string;
}

export const KIND_LABEL: Record<"owe" | "waiting" | "decision", string> = { owe: "You owe", waiting: "Waiting on", decision: "Decision" };
