import { personSlug } from "@/lib/people";
import type { SearchHit } from "@/lib/search";

export const personHref = (name: string) => `/people/${encodeURIComponent(personSlug(name))}`;

/** Where a search result goes: the person's page when it names one, else the full results. */
export function hitHref(h: SearchHit): string {
  if (h.type === "item" && h.person && personSlug(h.person)) return personHref(h.person);
  return `/search?q=${encodeURIComponent(h.type === "item" ? h.text : h.title)}`;
}
