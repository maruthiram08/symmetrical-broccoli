import Link from "next/link";
import { switchWorkspaceAction } from "@/app/workspace-actions";
import { getStore, me } from "@/server/local/app";
import { activeWorkspace, listWorkspaces } from "@/server/local/workspaces";
import { AutoSubmitSelect } from "./AutoSubmitSelect";

/** The sidebar's workspace picker. Shown only once there is more than one workspace. */
export function WorkspaceSwitch({ to = "/" }: { to?: string }) {
  const all = listWorkspaces();
  if (all.length < 2) return null;
  const active = activeWorkspace();
  return (
    <form action={switchWorkspaceAction} className="ws-switch">
      <input type="hidden" name="to" value={to} />
      <label className="ws-switch__label" htmlFor="ws-switch">Workspace</label>
      <AutoSubmitSelect id="ws-switch" name="workspace" className="ws-switch__select" defaultValue={active.id} key={active.id}>
        {all.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
      </AutoSubmitSelect>
      <noscript><button type="submit" className="db-act">Switch</button></noscript>
    </form>
  );
}

/** "Inbox 3" in the sidebar, when something is waiting to be sorted (or you are on the Inbox). */
export async function InboxLink({ current }: { current: string }) {
  const user = await me();
  const n = user ? (await getStore().listItems(user.id)).filter((i) => i.status === "inbox").length : 0;
  if (!n && current !== "inbox") return null;
  return (
    <Link className="db-nav" href="/inbox" aria-current={current === "inbox" ? "page" : undefined}>
      Inbox{n ? <span className="db-nav__n">{n}</span> : null}
    </Link>
  );
}

/** For one-column pages (Settings, Welcome): which workspace you are in, with a link to change it. */
export function WorkspaceBadge() {
  const all = listWorkspaces();
  if (all.length < 2) return null;
  return (
    <p className="ws-badge">
      Workspace <strong>{activeWorkspace().name}</strong> · <Link className="db-link" href="/workspaces">Change</Link>
    </p>
  );
}
