"use client";

// ⌘K's structure rows: loaded once each time the palette opens.
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { createTypedNoteAction, structureNavAction } from "@/app/structure-actions";
import { paletteRows, type PaletteData } from "@/lib/structure/palette";

export function useStructureRows(open: boolean, q: string) {
  const router = useRouter();
  const [data, setData] = useState<PaletteData>({ tags: [], views: [], types: [] });
  useEffect(() => {
    if (!open) return;
    void structureNavAction().then(setData).catch(() => {});
  }, [open]);
  return useMemo(() => paletteRows(data, q).map((r) => ({
    id: r.id, group: r.group, label: r.label, sub: r.sub, href: r.href, hl: r.hl,
    run: r.create ? () => {
      const c = r.create!;
      void createTypedNoteAction(c.typeId, c.title).then((x) => { if (x.ok) router.push(`/notes/${encodeURIComponent(x.slug)}`); }).catch(() => {});
    } : undefined,
  })), [data, q, router]);
}
