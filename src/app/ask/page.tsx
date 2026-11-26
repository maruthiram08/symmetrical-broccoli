import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AskBox } from "@/components/AskBox";
import { Shell } from "@/components/Shell";
import { PROVIDERS } from "@/lib/ai/providers";
import { aiPrefs, clientForTask, resolveTask } from "@/server/ai-config";
import { conversationRows, readThreads, viewOf } from "@/server/ask-threads";
import { me } from "@/server/local/app";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Ask" };

// Ask a question about your meetings. Local search finds the passages; the model picked for Ask
// answers from them and cites each one. Conversations branch and are kept per workspace.
export default async function Ask({ searchParams }: { searchParams: Promise<{ q?: string; t?: string }> }) {
  const user = await me();
  if (!user) redirect("/setup");
  const sp = await searchParams;
  const q = (sp.q ?? "").slice(0, 500).trim();
  const state = readThreads();
  const view = sp.t && /^[A-Za-z0-9-]{1,80}$/.test(sp.t) ? viewOf(state, sp.t) : null;
  const t = resolveTask("ask");
  const ready = t.provider === "anthropic" ? !!process.env.ANTHROPIC_API_KEY : (await clientForTask("ask")).ok;
  const local = aiPrefs().search.localOnly;
  const who = t.provider === "anthropic" ? "Claude" : PROVIDERS[t.provider].label;
  const hint = !ready
    ? t.provider === "anthropic" ? "Add ANTHROPIC_API_KEY, or pick another model for Ask in Settings › AI." : `Set up ${t.label} in Settings › AI to ask questions.`
    : PROVIDERS[t.provider].local
      ? "Searches on this Mac and answers with Ollama on this computer. Nothing leaves it."
      : `${local ? "Searches on this Mac" : "Searches with your settings"}, then sends ${who} the question and only the top passages.`;
  return (
    <Shell current="ask" raw={<AskBox initial={q} ready={ready} hint={hint} conversations={conversationRows(state)} view={view} panes={{ model: who === "Claude" ? "Anthropic API" : who }} />} />
  );
}
