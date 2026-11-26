import type { Metadata } from "next";
import { ViewsPanes } from "./_views";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Views" };

// Saved views over notes and items, and templates to start from. Each saved one is also in the sidebar.
export default async function Views({ searchParams }: { searchParams: Promise<{ start?: string }> }) {
  return <ViewsPanes id={null} start={(await searchParams).start ?? null} />;
}
