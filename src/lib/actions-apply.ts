// What the signed links in the email do. Kept small: direct Supabase calls with the service client.
import { serviceClient } from "@/lib/auth";
import type { LinkPayload } from "@/lib/links";

export type ApplyResult =
  | { ok: true; action: "done" | "wrong" | "undo"; itemText: string }
  | { ok: false; reason: "not_found" | "bad_action" };

const STATUS = { done: "done", wrong: "wrong", undo: "open" } as const;
const EVENT = { done: "done_click", wrong: "wrong_click", undo: "undo" } as const;

/** Marks an item done or wrong, or reopens it, and logs the click. Idempotent. */
export async function applyAction(p: LinkPayload): Promise<ApplyResult> {
  if (!p.i || (p.a !== "done" && p.a !== "wrong" && p.a !== "undo")) return { ok: false, reason: "bad_action" };
  const db = serviceClient();
  const status = STATUS[p.a];
  const { data, error } = await db
    .from("items")
    .update({ status, closed_at: status === "open" ? null : new Date().toISOString() })
    .eq("id", p.i)
    .eq("user_id", p.u)
    .select("id,text")
    .maybeSingle();
  if (error) throw new Error(`items update failed: ${error.message}`);
  if (!data) return { ok: false, reason: "not_found" };
  const { error: evError } = await db.from("events").insert({ user_id: p.u, type: EVENT[p.a], payload: { item_id: p.i } });
  if (evError) console.error("event log failed", evError.message);
  return { ok: true, action: p.a, itemText: data.text as string };
}

/** The user's notes as files: one YYYY-MM-DD.md per brief, plus decisions.md. */
export async function exportNotes(userId: string): Promise<Array<{ name: string; content: string }>> {
  const db = serviceClient();
  const [{ data: user }, { data: briefs, error: bErr }, { data: decisions, error: dErr }] = await Promise.all([
    db.from("users").select("time_zone").eq("id", userId).maybeSingle(),
    db.from("briefs").select("date,markdown").eq("user_id", userId).order("date", { ascending: true }),
    db
      .from("items")
      .select("text,quote,meeting_id,created_at")
      .eq("user_id", userId)
      .eq("kind", "decision")
      .neq("status", "wrong")
      .order("created_at", { ascending: true }),
  ]);
  if (bErr || dErr) throw new Error(`export failed: ${(bErr ?? dErr)?.message}`);
  const timeZone = (user?.time_zone as string | undefined) ?? "Asia/Kolkata";

  const meetingIds = [...new Set((decisions ?? []).map((d) => d.meeting_id as string))];
  const meetings = new Map<string, { title: string; started_at: string }>();
  if (meetingIds.length) {
    const { data } = await db.from("meetings").select("id,title,started_at").in("id", meetingIds);
    for (const m of data ?? []) meetings.set(m.id as string, { title: m.title as string, started_at: m.started_at as string });
  }

  const files = (briefs ?? []).map((b) => ({ name: `${b.date}.md`, content: b.markdown as string }));
  files.push({ name: "decisions.md", content: decisionsMarkdown(decisions ?? [], meetings, timeZone) });
  return files;
}

export function decisionsMarkdown(
  decisions: Array<{ text: string; quote: string; meeting_id: string; created_at: string }>,
  meetings: Map<string, { title: string; started_at: string }>,
  timeZone: string,
): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" });
  const out = ["# Decisions", ""];
  let current = "";
  for (const d of decisions) {
    const m = meetings.get(d.meeting_id);
    const when = new Date(m?.started_at ?? d.created_at);
    const date = day.format(when);
    if (date !== current) {
      if (current) out.push("");
      out.push(`## ${date}`, "");
      current = date;
    }
    const src = m ? ` · ${m.title}, ${time.format(when)}` : "";
    out.push(`- ${d.text}`, `  "${d.quote}"${src}`);
  }
  if (!decisions.length) out.push("No decisions yet.");
  return out.join("\n") + "\n";
}

/** Deletes everything we hold for the user. Tables cascade from users. */
export async function deleteAccount(userId: string): Promise<void> {
  const db = serviceClient();
  const { error } = await db.from("users").delete().eq("id", userId);
  if (error) throw new Error(`delete failed: ${error.message}`);
  // users.id is the Supabase Auth id for users who signed up through the magic link.
  const { error: authErr } = await db.auth.admin.deleteUser(userId);
  if (authErr && authErr.status !== 404) console.error("auth user delete failed", authErr.message);
}
