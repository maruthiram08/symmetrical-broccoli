import Link from "next/link";
import { isHosted } from "@/server/mode";
import { hostedConfig } from "@/server/hosted/config";

/** Sidebar links that only exist when hosted: account, plan, team. Renders nothing locally. */
export function HostedLinks() {
  if (!isHosted()) return null;
  const cfg = hostedConfig();
  return (
    <>
      {cfg.teamsEnabled ? <Link className="db-nav" href="/team">Team</Link> : null}
      {cfg.billing.enabled ? <Link className="db-nav" href="/billing">Plan</Link> : null}
      <Link className="db-nav" href="/account">Account</Link>
    </>
  );
}
