import type { Metadata } from "next";
import Link from "next/link";
import { Page } from "@/components/Page";
import { TemplateEditor } from "@/components/TemplateEditor";
import { isTemplateKind, TEMPLATE_INFO, TEMPLATE_KINDS } from "@/lib/templates/kinds";
import { readSyncStatus } from "@/server/local/sync-status";
import { loadTemplate } from "@/server/local/templates";
import { currentWorkspace, linksOn } from "@/server/local/workspaces";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Templates" };

export default async function Templates({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const { kind: k } = await searchParams;
  const kind = k && isTemplateKind(k) ? k : "daily";
  const ws = currentWorkspace();
  const mine = loadTemplate(ws, kind);
  const problem = readSyncStatus(ws).template;
  return (
    <Page title="Templates">
      <p className="db-lead">
        How the Markdown notes in <span className="db-mono">{ws.name}</span> are laid out. The defaults write the notes exactly as
        before. Templates are kept in this workspace&apos;s <span className="db-mono">.daily-brief/templates/</span>.
      </p>
      <p className="tp-back"><Link className="db-link" href="/setup#sync">Back to Settings</Link></p>
      {problem && !problem.ok ? <p className="db-note db-note--error" role="alert">{problem.detail}</p> : null}
      <nav className="tp-tabs" aria-label="Templates">
        {TEMPLATE_KINDS.map((t) => (
          <Link key={t} href={`/setup/templates?kind=${t}`} className="tp-tabs__tab" aria-current={t === kind ? "page" : undefined}>{TEMPLATE_INFO[t].label}</Link>
        ))}
      </nav>
      <TemplateEditor key={kind} kind={kind} initial={mine ?? TEMPLATE_INFO[kind].defaults} custom={mine !== null} links={linksOn(ws)} />
    </Page>
  );
}
