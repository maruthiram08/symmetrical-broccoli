import { Page } from "@/components/Page";

export default async function Deleted({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  const { expired } = await searchParams;
  if (expired) {
    return (
      <Page title="This link has expired.">
        <p className="db-lead">Use the Delete my data link in your latest brief.</p>
      </Page>
    );
  }
  return (
    <Page title="Your data is deleted.">
      <p className="db-lead">Your notes, items and connection are gone. No more briefs will be sent.</p>
    </Page>
  );
}
