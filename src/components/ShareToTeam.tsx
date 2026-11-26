import { Button } from "@/components/Button";
import { setItemShared } from "@/app/hosted-actions";
import { isHosted } from "@/server/mode";
import { rootStore, sessionUserId } from "@/server/hosted/app";
import { hostedConfig } from "@/server/hosted/config";
import { listWorkspaces, sharesOf } from "@/server/hosted/teams";

/** On an item's page (hosted, teams on): share it with, or take it back from, each of your teams. */
export async function ShareToTeam({ itemId }: { itemId: string }) {
  if (!isHosted() || !hostedConfig().teamsEnabled) return null;
  const uid = await sessionUserId();
  if (!uid) return null;
  const db = rootStore().db;
  const workspaces = await listWorkspaces(db, uid);
  if (!workspaces.length) return null;
  const shared = new Set((await sharesOf(db, uid)).get(itemId) ?? []);
  return (
    <div className="db-h-share">
      {workspaces.map((w) => (
        <form key={w.id} action={setItemShared}>
          <input type="hidden" name="ws" value={w.id} />
          <input type="hidden" name="item" value={itemId} />
          <input type="hidden" name="on" value={shared.has(w.id) ? "0" : "1"} />
          <Button type="submit" variant={shared.has(w.id) ? "secondary" : "ghost"}>{shared.has(w.id) ? `Shared with ${w.name} · Unshare` : `Share with ${w.name}`}</Button>
        </form>
      ))}
    </div>
  );
}
