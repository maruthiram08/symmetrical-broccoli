import { highlight } from "@/lib/search";

/** Text with the query's words wrapped in <mark>. Works on the server and in the palette. */
export function Highlight({ text, q }: { text: string; q: string | string[] }) {
  return (
    <>
      {highlight(text, q).map((s, k) => (s.hit ? <mark key={k} className="db-hl">{s.text}</mark> : s.text))}
    </>
  );
}
