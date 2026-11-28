// The found threads and the people view, from what the page loaded. Reads threads.json for what
// you dismissed; never writes, never files.
import { groupNames, ownsItem, type PersonGroup } from "@/lib/people";
import { findThreads, type FoundThread } from "@/lib/reading/threads";
import type { Person } from "@/lib/directory/directory";
import type { Item, Meeting, User } from "@/lib/types";
import { readThreads } from "@/server/local/threads";

export function personResolver(user: User, items: Item[], people: Person[]): { groups: PersonGroup[]; personOf: (i: Item) => string | null } {
  const groups = groupNames(items.filter((i) => i.status !== "wrong").map((i) => i.person ?? "").filter(Boolean), [user.name, ...user.aliases], people);
  const cache = new Map<string, string | null>();
  const personOf = (i: Item) => {
    if (!i.person) return null;
    const k = `${i.personId ?? ""}|${i.person}`;
    if (!cache.has(k)) cache.set(k, groups.find((g) => ownsItem(g, i))?.name ?? null);
    return cache.get(k)!;
  };
  return { groups, personOf };
}

export function loadThreads(user: User, items: Item[], meetings: Meeting[], people: Person[], now = new Date()): FoundThread[] {
  const { groups, personOf } = personResolver(user, items, people);
  return findThreads({
    items, meetings, now, timeZone: user.timeZone, personOf,
    nameWords: [user.name, ...user.aliases, ...groups.flatMap((g) => g.spellings)],
    dismissed: readThreads().dismissed,
  });
}
