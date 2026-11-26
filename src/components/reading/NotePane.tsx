"use client";

// One note in the reading pane's detail: the workbench's editor for that file. Links to another
// note open it in this pane; anything else is a normal page.
import { useRouter } from "next/navigation";
import { VaultPane, type PaneContext } from "../vault/VaultPane";

export function NotePane({ path, ctx }: { path: string; ctx: PaneContext }) {
  const router = useRouter();
  return (
    <div className="rp-notewrap">
      <VaultPane key={path} path={path} ctx={ctx} onNavigate={(href, newTab) => {
        if (newTab) window.open(href, "_blank"); else router.push(href);
        return true;
      }} onGone={() => router.refresh()} />
    </div>
  );
}
