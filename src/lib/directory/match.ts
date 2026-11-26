// Does a name written somewhere else (a [[person:X]] link in a note) mean this person? Pure.
import { belongsTo, type PersonGroup } from "@/lib/people";
import { resolver, type Person } from "./directory";
import { isSpeakerLabel } from "./speakers";

/**
 * Through the directory first: a name it knows (any confirmed spelling) belongs only to that
 * person, and an ignored name to nobody; otherwise the People spelling rules. Speaker labels mean nobody.
 */
export function linkIsPerson(person: PersonGroup, name: string, people: Person[] = []): boolean {
  if (isSpeakerLabel(name)) return false;
  const known = people.length ? resolver({ people, moved: {} }).lookup(name) : null;
  if (known) return known.status === "confirmed" && known.id === person.personId;
  return belongsTo(person, name);
}
