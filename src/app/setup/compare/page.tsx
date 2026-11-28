import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Page } from "@/components/Page";
import { CompareRunner } from "@/components/ai/CompareRunner";
import { estimateCompareAction, runCompareAction } from "@/app/compare-actions";
import { AI_TASKS, PROVIDERS, providersFor } from "@/lib/ai/providers";
import { formatTime, localDate } from "@/lib/brief/time";
import { aiPrefs, resolveTask } from "@/server/ai-config";
import { getStore, me } from "@/server/local/app";
import { isHosted } from "@/server/mode";
import { PROVIDER_LABEL } from "@/server/recorders";
import { providerOf } from "@/lib/types";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Compare models" };

// Settings › AI › Compare: one past meeting, 2-3 provider/model pairs, side by side.
export default async function Compare() {
  const user = await me();
  if (!user) redirect("/welcome");
  const meetings = (await getStore().listMeetingsBetween(user.id, "0000", "9999"))
    .filter((m) => m.processedAt && !m.duplicateOf)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 100)
    .map((m) => ({ id: m.id, label: `${m.title} · ${localDate(new Date(m.startedAt), user.timeZone)} ${formatTime(m.startedAt, user.timeZone)} · ${PROVIDER_LABEL[providerOf(m)]}` }));
  const p = aiPrefs();
  const providers = providersFor(isHosted()).map((x) => ({ id: x.id, label: x.label, suggestions: [...new Set([...x.suggestions, ...(p.providers[x.id]?.models ?? [])])].slice(0, 200) }));
  const ex = resolveTask("extraction", p);
  const other = AI_TASKS.map((t) => resolveTask(t, p)).find((r) => r.qualified !== ex.qualified);
  const initial = [{ provider: ex.provider, model: ex.model }, other ? { provider: other.provider, model: other.model } : { provider: "ollama" as const, model: PROVIDERS.ollama.suggestions[0] }];
  return (
    <Page title="Compare models">
      <p className="db-lead">
        Read one past meeting with two or three models and see what each finds, side by side. Nothing is saved to your lists. It spends credit on each
        paid model, so you see the estimate and confirm first. <Link href="/setup#ai">Back to Settings › AI</Link>
      </p>
      {meetings.length ? (
        <CompareRunner meetings={meetings} providers={providers} initial={initial} estimate={estimateCompareAction} run={runCompareAction} />
      ) : (
        <p className="db-note">No meetings read yet. Once a meeting has been read, you can compare models on it here.</p>
      )}
    </Page>
  );
}
