import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/Button";
import { Page } from "@/components/Page";
import { applyAction } from "@/lib/actions-apply";
import { actionUrl, verifyToken } from "@/lib/links";
import { confirmDelete } from "../../actions";

export const dynamic = "force-dynamic";

const MESSAGES = {
  done: "Marked done.",
  wrong: "Marked as wrong. Thanks, this helps us improve.",
  undo: "Undone. It's open again.",
} as const;

function undoPath(userId: string, itemId: string): string {
  return new URL(actionUrl(userId, itemId, "undo")).pathname;
}

export default async function ActionLink({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const p = verifyToken(token);
  if (!p) {
    return (
      <Page title="This link has expired.">
        <p className="db-lead">Links in a brief work for 30 days. Your next brief has fresh ones.</p>
      </Page>
    );
  }

  if (p.a === "download") redirect(`/a/${token}/download`);

  if (p.a === "delete") {
    return (
      <Page title="Delete your data?">
        <p className="db-lead">This deletes your notes, items, briefs and your Wispr Flow connection. It can&apos;t be undone.</p>
        <form action={confirmDelete}>
          <input type="hidden" name="token" value={token} />
          <Button type="submit">Delete my data</Button>
        </form>
      </Page>
    );
  }

  const result = await applyAction(p);
  if (!result.ok) {
    return (
      <Page title="That item is gone.">
        <p className="db-lead">It may have been deleted with your data.</p>
      </Page>
    );
  }
  return (
    <Page title={MESSAGES[result.action]}>
      <p className="db-lead">{result.itemText}</p>
      {result.action !== "undo" && p.i ? (
        <Link className="db-link" href={undoPath(p.u, p.i)}>
          Undo
        </Link>
      ) : null}
    </Page>
  );
}
