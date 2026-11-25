import Link from "next/link";
import { notFound } from "next/navigation";
import { renderEmail } from "@/lib/email/render";
import { fixtureLinks, fixtureVariant } from "@/lib/email/fixture";

export const dynamic = "force-dynamic";

const VARIANTS = ["full", "nothing_owed", "no_meetings", "still_open"] as const;
type Variant = (typeof VARIANTS)[number];

/** Dev-only preview of the email for screenshots. The email renders in sandboxed iframes, no scripts. */
export default async function EmailPreview({ searchParams }: { searchParams: Promise<{ v?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { v } = await searchParams;
  const variant: Variant = VARIANTS.includes(v as Variant) ? (v as Variant) : "full";
  const email = renderEmail(fixtureVariant(variant), fixtureLinks);
  return (
    <main className="db-preview">
      <div className="db-row">
        {VARIANTS.map((name) => (
          <Link key={name} className="db-link" href={`/dev/email?v=${name}`} aria-current={name === variant ? "page" : undefined}>
            {name.replace("_", " ")}
          </Link>
        ))}
      </div>
      <p className="db-note">
        Subject: <span className="db-mono">{email.subject}</span>
      </p>
      <div className="db-preview__frames">
        <iframe className="db-preview__frame" title="Email, 600px" sandbox="" srcDoc={email.html} width={640} height={1500} />
        <iframe className="db-preview__frame" title="Email, phone width" sandbox="" srcDoc={email.html} width={375} height={1500} />
      </div>
      <pre>{email.text}</pre>
    </main>
  );
}
