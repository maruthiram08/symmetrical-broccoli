import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "./Mark";

/** One centred 480px column with the brand mark and one title. */
export function Page({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  return (
    <main className="db-page">
      <div className="db-page__col">
        <Link className="db-brand" href="/">
          <Mark kind="owe" />
          Daily brief
        </Link>
        {title ? <h1 className="db-title">{title}</h1> : null}
        {children}
      </div>
    </main>
  );
}
