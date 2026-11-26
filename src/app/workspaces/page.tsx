import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/Button";
import { Field } from "@/components/Field";
import { Page } from "@/components/Page";
import { activeWorkspace, HOME_ID, listWorkspaces } from "@/server/local/workspaces";
import { addWorkspaceAction, removeWorkspaceAction, renameWorkspaceAction, switchWorkspaceAction } from "../workspace-actions";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Workspaces" };

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");

// Each workspace is a notes folder with its own items, notes and Wispr Flow connection.
export default async function Workspaces({ searchParams }: { searchParams: Promise<{ error?: string; removed?: string }> }) {
  const { error, removed } = await searchParams;
  const all = listWorkspaces();
  const active = activeWorkspace();
  return (
    <Page title="Workspaces">
      <p className="db-lead">
        A workspace is one notes folder with its own meetings, items, daily notes and Wispr Flow account. Use one for work and one
        for a side project, say. The one you pick stays picked.
      </p>
      {error ? <p className="db-note db-note--error" role="alert">{error}</p> : null}
      {removed ? <p className="db-note" role="status">Taken off the list. Its folder and files are still there.</p> : null}
      <ul className="ws-list" aria-label="Your workspaces">
        {all.map((w) => (
          <li key={w.id} className="ws-list__row" aria-current={w.id === active.id ? "true" : undefined}>
            <div className="ws-list__main">
              <span className="ws-list__name">{w.name}{w.id === active.id ? <span className="ws-list__tag">Current</span> : null}</span>
              <span className="ws-list__path db-mono">{tilde(w.path)}</span>
            </div>
            <div className="ws-list__acts">
              {w.id !== active.id ? (
                <form action={switchWorkspaceAction}>
                  <input type="hidden" name="workspace" value={w.id} />
                  <Button type="submit" variant="secondary">Switch</Button>
                </form>
              ) : null}
              <details className="ws-list__more">
                <summary className="db-act">Rename{w.id !== HOME_ID ? " or remove" : ""}</summary>
                <form action={renameWorkspaceAction} className="ws-list__rename">
                  <input type="hidden" name="id" value={w.id} />
                  <input className="db-input" name="name" defaultValue={w.name} aria-label="Name" maxLength={60} required />
                  <Button type="submit" variant="secondary">Save</Button>
                </form>
                {w.id !== HOME_ID ? (
                  <form action={removeWorkspaceAction} className="ws-list__remove">
                    <input type="hidden" name="id" value={w.id} />
                    <span className="db-field__hint">Takes it off this list. Nothing in the folder is deleted, and you can add it again later.</span>
                    <Button type="submit" variant="ghost">Remove from list</Button>
                  </form>
                ) : null}
              </details>
            </div>
          </li>
        ))}
      </ul>
      <form action={addWorkspaceAction} className="db-stack db-subsection">
        <h2 className="db-section__title">Add a workspace</h2>
        <Field id="ws-name" name="name" label="Name" placeholder="Side project" maxLength={60} required />
        <Field id="ws-folder" name="folder" label="Folder" placeholder="~/Documents/Side project brief" required
          hint="Its notes go here, and its data in a hidden .daily-brief folder inside. Created if it doesn't exist. An existing workspace folder is picked up as it is." />
        <div className="db-row">
          <Button type="submit">Add and switch</Button>
          <Link className="db-link" href="/">Back to today</Link>
        </div>
        <p className="db-note" style={{ marginTop: 0 }}>Your name and brief time are copied over. Connect Wispr Flow for it next: each workspace has its own account.</p>
      </form>
    </Page>
  );
}
