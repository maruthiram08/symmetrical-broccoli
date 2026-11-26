import type { Metadata } from "next";
import Link from "next/link";
import { Mark } from "@/components/Mark";
import { ReloadButton } from "@/components/PwaRegister";

export const dynamic = "force-static";
export const metadata: Metadata = { title: "Offline" };

/** Shown by the service worker when a page isn't saved on this device and the Mac can't be reached. */
export default function Offline() {
  return (
    <main className="db-page">
      <div className="db-page__col">
        <Link className="db-brand" href="/">
          <Mark kind="owe" />
          Daily brief
        </Link>
        <h1 className="db-title">You&apos;re offline</h1>
        <p className="db-lead">
          This page isn&apos;t saved on this device, and your Mac can&apos;t be reached right now. These were saved the last time
          you opened them, and open without a connection:
        </p>
        {/* Plain links on purpose: a full page load lets the service worker answer from its saved copy. */}
        {/* eslint-disable @next/next/no-html-link-for-pages */}
        <ul className="db-offline__list">
          <li><a href="/">Today</a><span>What you owe, waiting on and decisions</span></li>
          <li><a href="/open">All open</a><span>Everything still open</span></li>
          <li><a href="/people">People</a><span>Who owes what, by person</span></li>
        </ul>
        {/* eslint-enable @next/next/no-html-link-for-pages */}
        <p className="db-note">Saved pages are read-only. Done, Snooze and Add work again once your phone can reach your Mac.</p>
        <div className="db-row" style={{ marginTop: 24 }}>
          <ReloadButton />
        </div>
      </div>
    </main>
  );
}
