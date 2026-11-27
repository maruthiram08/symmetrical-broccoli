// The small card the Mac app shows in the top-right corner after ⌃⌥⌘C (src-tauri/src/main.rs,
// show_toast): what was added, and Undo, the kind switch and Open. Bare page: no shell.
import type { Metadata } from "next";
import { getStore, me } from "@/server/local/app";
import { projectLabel } from "@/lib/structure/views";
import { projectRows } from "@/server/structure/notes";
import { CaptureCard } from "./CaptureCard";
import "./captured.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Added" };

const ERRORS: Record<string, [string, string]> = {
  empty: ["Nothing to add", "Copy a Slack message or thread first (⌘C), then press ⌃⌥⌘C."],
  same: ["Already added", "That's what you added last time. Copy another message, then press ⌃⌥⌘C."],
};

export default async function Captured({ searchParams }: { searchParams: Promise<{ id?: string; error?: string; detail?: string }> }) {
  const q = await searchParams;
  const user = await me();
  const item = q.id && user ? (await getStore().listItems(user.id)).find((i) => i.id === q.id) ?? null : null;
  if (!item) {
    const [title, detail] = ERRORS[q.error ?? ""] ?? ["Couldn't add it", q.detail?.slice(0, 160) || "Try copying the message again."];
    return <CaptureCard error={{ title, detail }} />;
  }
  let project = item.project ? projectLabel(item.project) : null;
  try { project = projectRows().find((r) => r.slug === item.project)?.title ?? project; } catch { /* no notes folder */ }
  return (
    <CaptureCard
      item={{
        id: item.id, kind: item.kind === "waiting" ? "waiting" : "owe", text: item.text, person: item.person,
        inbox: item.status === "inbox", project,
        slack: item.origin?.app === "slack", due: !!item.dueAt,
      }}
    />
  );
}
