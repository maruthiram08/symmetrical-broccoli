import Link from "next/link";
import { saveFolderSyncAction, saveGitAction, saveLinksAction, syncNowAction } from "@/app/workspace-actions";
import { me } from "@/server/local/app";
import { isGitRepo } from "@/server/local/git-sync";
import { readSyncStatus, type SyncResult } from "@/server/local/sync-status";
import { currentWorkspace, gitSettings, linksOn, listWorkspaces } from "@/server/local/workspaces";
import { Button } from "./Button";
import { SubmitOnChange } from "./SubmitOnChange";

const tilde = (p: string) => p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");

function Last({ r, label, tz }: { r?: SyncResult; label: string; tz?: string }) {
  if (!r) return null;
  const when = new Date(r.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: tz });
  return <p className={`db-note${r.ok ? "" : " db-note--error"}`} style={{ marginTop: 0 }}>{label}, {when}: {r.detail}</p>;
}

/** Settings: workspace, links, folder sync, git and templates. All per workspace. */
export async function SyncSettings({ syncError, gitError }: { syncError?: string; gitError?: string }) {
  const ws = currentWorkspace();
  const count = listWorkspaces().length;
  const status = readSyncStatus(ws);
  const git = gitSettings(ws);
  const repo = await isGitRepo(ws.path);
  const tz = (await me())?.timeZone;
  return (
    <>
      <section className="db-stack db-subsection" aria-labelledby="ws-title">
        <h2 className="db-section__title" id="ws-title">Workspace</h2>
        <p className="db-note" style={{ marginTop: 0 }}>
          <strong>{ws.name}</strong>, in <span className="db-mono">{tilde(ws.path)}</span>.{" "}
          {count > 1 ? `${count} workspaces. ` : ""}<Link className="db-link" href="/workspaces">{count > 1 ? "Switch or add one" : "Add another workspace"}</Link>
        </p>
      </section>

      <section id="sync" className="db-stack db-subsection" aria-labelledby="sync-title">
        <h2 className="db-section__title" id="sync-title">Notes, links and sync</h2>
        <form action={saveLinksAction} className="db-stack">
          <label className="db-check">
            <SubmitOnChange name="links" defaultChecked={linksOn(ws)} />
            <span>
              <span className="db-check__label">Link people, meetings and decisions</span>
              <span className="db-field__hint">
                Writes <span className="db-mono">[[Nitin]]</span>-style links, plus a page per person in <span className="db-mono">people/</span> and
                per meeting in <span className="db-mono">meetings/</span>, so backlinks work in Obsidian and similar apps.
              </span>
            </span>
          </label>
        </form>
        <p className="db-note" style={{ marginTop: 0 }}>
          <Link className="db-link" href="/setup/templates">Edit templates</Link> for the daily note, weekly recap and meeting notes.
        </p>

        <form action={saveFolderSyncAction} className="db-stack">
          <h3 className="ws-h3">Folder sync</h3>
          <label className="db-check">
            <input className="db-switch" type="checkbox" role="switch" name="enabled" defaultChecked={!!ws.sync?.enabled} />
            <span>
              <span className="db-check__label">Copy my notes to another folder</span>
              <span className="db-field__hint">
                After each brief, daily notes, decisions.md, weekly recaps and person pages are copied into a <span className="db-mono">daily-brief/</span> folder
                inside it: an iCloud Drive folder, say, or an Obsidian vault. One way: edit the originals, the copies are replaced. Nothing outside <span className="db-mono">daily-brief/</span> is touched.
              </span>
            </span>
          </label>
          <div className="db-field">
            <label className="db-field__label" htmlFor="sync-folder">Folder</label>
            <input className="db-input db-mono" id="sync-folder" name="folder" defaultValue={ws.sync?.folder ? tilde(ws.sync.folder) : ""} placeholder="~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Vault" />
          </div>
          {syncError ? <p className="db-note db-note--error" role="alert">{syncError}</p> : null}
          <div className="db-row">
            <Button type="submit" variant="secondary">Save</Button>
          </div>
          <Last r={status.folder} label="Last copy" tz={tz} />
        </form>

        <form action={saveGitAction} className="db-stack">
          <h3 className="ws-h3">Git</h3>
          <p className="db-note" style={{ marginTop: 0 }}>
            {repo ? "Your notes folder is a git repo." : <>Your notes folder isn&apos;t a git repo. Run <span className="db-mono">git init</span> in it to turn this on.</>}
          </p>
          <label className="db-check">
            <input className="db-switch" type="checkbox" role="switch" name="commit" defaultChecked={git.commit} />
            <span>
              <span className="db-check__label">Commit after each brief</span>
              <span className="db-field__hint">Commits only the notes the brief wrote, as “Daily brief 2026-11-26”, with your git name and email.</span>
            </span>
          </label>
          <label className="db-check">
            <input className="db-switch" type="checkbox" role="switch" name="push" defaultChecked={git.push} />
            <span>
              <span className="db-check__label">Then push</span>
              <span className="db-field__hint">Uses your own git credentials (Keychain or SSH key). Daily brief never stores a token; if git would ask for a password, the push is skipped.</span>
            </span>
          </label>
          <div className="db-field">
            <label className="db-field__label" htmlFor="git-remote">Remote</label>
            <input className="db-input db-mono" id="git-remote" name="remote" defaultValue={git.remote} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9._\-]*" />
          </div>
          {gitError ? <p className="db-note db-note--error" role="alert">{gitError}</p> : null}
          <div className="db-row"><Button type="submit" variant="secondary">Save</Button></div>
          <Last r={status.git} label="Last commit" tz={tz} />
          <Last r={status.push} label="Last push" tz={tz} />
        </form>
        <form action={syncNowAction} className="db-row">
          <Button type="submit" variant="ghost">Sync now</Button>
        </form>
      </section>
    </>
  );
}
