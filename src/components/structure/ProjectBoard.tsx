"use client";

// A project's items as a Kanban: You owe, Waiting on, Done. Dragging to Done closes an item;
// dragging back reopens it; your own items can also move between You owe and Waiting on.
import { moveProjectItemAction } from "@/app/structure-actions";
import { OPEN_CAPTURE, type CaptureDetail } from "../QuickCapture";
import { Kanban, type Column } from "./Kanban";

export function ProjectBoard({ columns, slug }: { columns: Column[]; slug: string }) {
  return (
    <>
      <Kanban columns={columns} label="Project items" onMove={(id, to) => moveProjectItemAction(id, to as "owe" | "waiting" | "done")} />
      <p className="st-hint">
        <button type="button" className="db-act" onClick={() => window.dispatchEvent(new CustomEvent<CaptureDetail>(OPEN_CAPTURE, { detail: { text: ` +${slug}` } }))}>Add an item</button>
        <span>Or type <span className="db-mono">+{slug}</span> in quick capture (<span className="db-kbd">C</span>).</span>
      </p>
    </>
  );
}
