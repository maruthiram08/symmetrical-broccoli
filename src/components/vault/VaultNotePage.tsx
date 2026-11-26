import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { Shell } from "@/components/Shell";
import { me } from "@/server/local/app";
import { notesDir } from "@/server/local/paths";
import { resolveNotePath } from "@/server/local/vault";
import { openCountFor, pastDays } from "@/app/_lib/days";
import { vaultContext } from "@/app/_lib/vault";
import { VaultWorkbench } from "./VaultWorkbench";

/** Decode a URL segment once, tolerating a stray "%". */
export function safeDecode(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** /notes and /notes/<path>: the workbench, with `path` (any .md in the workspace folder) in front. */
export async function VaultNotePage({ path, children, after }: { path: string | null; children?: ReactNode; after?: ReactNode }) {
  const user = await me();
  if (!user) redirect("/setup");
  let resolved: string | null = null;
  if (path !== null) {
    resolved = resolveNotePath(notesDir(), path);
    if (!resolved) notFound();
  }
  const ctx = await vaultContext(user);
  return (
    <Shell days={await pastDays(user.id, "")} current="notes" openCount={await openCountFor(user.id)} wide>
      <VaultWorkbench ctx={ctx} initialPath={resolved}>{children}</VaultWorkbench>
      {after}
    </Shell>
  );
}
