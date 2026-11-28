"use client";

// "Add all N missed": the cross-check's own Add, once per missed line, then a refresh.
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { addFromCrossCheckAction } from "@/app/crosscheck-actions";

export function AddAllMissed({ meetingId, rows }: { meetingId: string; rows: Array<{ index: number; kind: "owe" | "waiting" }> }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  if (!rows.length) return null;
  return (
    <button type="button" className="rp-btn rp-btn--pri" disabled={pending} onClick={() => start(async () => {
      for (const r of rows) {
        const fd = new FormData();
        fd.set("meetingId", meetingId);
        fd.set("index", String(r.index));
        fd.set("kind", r.kind);
        await addFromCrossCheckAction(fd);
      }
      router.refresh();
    })}>
      {pending ? "Adding…" : `Add all ${rows.length} missed`}
    </button>
  );
}
