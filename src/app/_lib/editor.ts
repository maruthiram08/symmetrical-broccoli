import { localDate } from "@/lib/brief/time";
import type { User } from "@/lib/types";
import { getStore } from "@/server/local/app";
import { listPages } from "@/server/local/pages";

export type AssistStatus = { enabled: true } | { enabled: false; reason: string };

/** Whether writing assist can run now, and why not: no key, or the account problem the banner shows. */
export async function assistStatusFor(): Promise<AssistStatus> {
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
