import Link from "next/link";
import type { ReactNode } from "react";
import { Mark } from "./Mark";
import { Alerts, loadAlerts } from "./Alerts";
import { me } from "@/server/local/app";

/** One centred 480px column with the brand mark and one title. Problems to fix show above the title. */
export async function Page({ title, children }: { title?: ReactNode; children?: ReactNode }) {
  const user = await me();
  const alerts = user ? await loadAlerts(user) : [];
  return (
    <main className="db-page">
      <div className="db-page__col">
        <Link className="db-brand" href="/">
          <Mark kind="owe" />
          Daily brief
        </Link>
        {user ? <div className="db-alerts"><Alerts alerts={alerts} user={user} /></div> : null}
        {title ? <h1 className="db-title">{title}</h1> : null}
        {children}
      </div>
    </main>
  );
}
