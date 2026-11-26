import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Page } from "@/components/Page";
import { ProtectForm } from "@/components/ProtectForm";
import { fileBase } from "@/lib/export/doc";
import { me } from "@/server/local/app";
import { exportDoc } from "@/server/local/export";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Share as protected file" };

export default async function Protect({ params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id: raw } = await params;
  const id = decodeURIComponent(raw);
  const user = await me();
  if (!user) redirect("/setup");
  const doc = await exportDoc(user, type, id);
  if (!doc) notFound();
  return (
    <Page title="Share as protected file">
      <ProtectForm source={`/api/export/${type}/${encodeURIComponent(id)}?format=inline`} fileName={`${fileBase(doc.title)}-protected.html`} title={doc.title} />
    </Page>
  );
}
