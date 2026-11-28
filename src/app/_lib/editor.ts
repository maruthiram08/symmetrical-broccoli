import { localDate } from "@/lib/brief/time";
import type { User } from "@/lib/types";
import { getStore } from "@/server/local/app";
import { listPages } from "@/server/local/pages";
import { aiPrefs, clientForTask, messageFor, resolveTask } from "@/server/ai-config";

export type AssistStatus = { enabled: true } | { enabled: false; reason: string };

/** Whether writing assist can run now, and why not: no key, or the account problem the banner shows. */
export async function assistStatusFor(): Promise<AssistStatus> {
  // Another provider picked for Writing assist in Settings › AI: its key and its last problem.
  const t = resolveTask("assist");
  if (t.provider !== "anthropic") {
    const r = await clientForTask("assist");
    if (!r.ok) return { enabled: false, reason: r.error };
    const pr = aiPrefs().problems[t.provider];
    return pr ? { enabled: false, reason: `${messageFor(t.provider, pr.kind)} (Settings › AI)` } : { enabled: true };
  }
  if (!process.env.ANTHROPIC_API_KEY) return { enabled: false, reason: "Add ANTHROPIC_API_KEY to use writing assist." };
  const problem = (await getStore().getHealth()).anthropicProblem;
  if (problem) {
    return {
      enabled: false,
      reason: problem.kind === "auth"
        ? "Your Anthropic key was rejected. Fix it (see the banner), then try again."
        : "Your Anthropic account is out of credit. Add credit (see the banner), then try again.",
    };
  }
  return { enabled: true };
}

/** What every notes editor on a page needs from the server. */
export async function editorContext(user: User, now = new Date()) {
  return {
    timeZone: user.timeZone,
    today: localDate(now, user.timeZone),
    assist: await assistStatusFor(),
    notes: listPages().map((p) => ({ slug: p.slug, title: p.title })),
  };
}
