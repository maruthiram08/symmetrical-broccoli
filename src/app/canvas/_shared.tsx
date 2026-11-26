import Link from "next/link";
import type { ReactNode } from "react";
import { Shell } from "@/components/Shell";
import type { User } from "@/lib/types";
import { openCountFor, pastDays } from "../_lib/days";


/** The page frame every canvas view shares: title, a way back, then the board. */
export async function CanvasFrame({ user, title, sub, children }: { user: User; title: string; sub?: string; children: ReactNode }) {
  return (
    <Shell days={await pastDays(user.id, "")} current="canvas" openCount={await openCountFor(user.id)} wide>
      <p className="cv-back"><Link href="/canvas">← Canvas</Link></p>
      <h1 className="db-title">{title}</h1>
      {sub ? <p className="db-subtitle">{sub}</p> : null}
      {children}
    </Shell>
  );
}
