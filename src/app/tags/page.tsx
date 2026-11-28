import type { Metadata } from "next";
import { TagsPanes } from "./_tags";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tags" };

// Every tag in notes and on items, most used first; the top one is open on the right.
export default async function Tags() {
  return <TagsPanes tag={null} />;
}
