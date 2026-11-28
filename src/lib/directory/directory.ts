// The people directory: the people you have confirmed (with the other spellings that mean them)
// and the names you said are not a person. Items keep the name as it was extracted; every read
// resolves it through here. No directory (or an empty one) changes nothing.
// Pure: the store keeps one Directory per user and applies the ops these functions return.

import type { CalendarCache, Item, Meeting, UpcomingMeeting } from "@/lib/types";
import { isSpeakerLabel, unlabelText } from "./speakers";

export type PersonStatus = "confirmed" | "ignored";

export interface Person {
  id: string;
  /** The spelling shown everywhere. */
  name: string;
  /** Other spellings that mean this person ("Mungu", "Manku"), as written. */
  aliases: string[];
  email?: string | null;
  note?: string | null;
  /** confirmed: a real person. ignored: not a person (transcription noise); items show no name. */
  status: PersonStatus;
  createdAt: string;
}

export interface Directory {
  people: Person[];
  /** Items moved to another person by a split: item id -> person id. */
  moved: Record<string, string>;
}

/** One undoable action: what it did, as ops that can be reversed on their own. */
export interface PeopleChange {
  id: string;
  at: string;
  /** "Munkku is Mangku" */
  label: string;
  ops: PeopleOp[];
  undone?: boolean;
}

export type PeopleOp =
  | { t: "put"; before: Person | null; after: Person | null }
  | { t: "move"; itemId: string; before: string | null; after: string | null };

export const emptyDirectory = (): Directory => ({ people: [], moved: {} });

/** "  Nitin  K. " -> "nitin k". Same rule as People (kept here so this module has no imports from it). */
export function nameKey(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tidy = (s: string) => s.trim().replace(/\s+/g, " ");

/** Every key a person answers to: the name and each alias. */
export const keysOf = (p: Person): string[] => [...new Set([p.name, ...p.aliases].map(nameKey).filter(Boolean))];

export const confirmed = (d: Directory | null | undefined): Person[] => (d?.people ?? []).filter((p) => p.status === "confirmed");

const isEmpty = (d: Directory | null | undefined) => !d || (!d.people.length && !Object.keys(d.moved).length);

// ---------- resolving ----------

export interface Resolver {
  /** The person a raw name means, or null when the directory doesn't know it. */
  lookup(raw: string | null | undefined): Person | null;
  /** An item as every page should see it: person is the confirmed name (or null when ignored). */
  item(i: Item): Item;
  /** A participant or attendee: a name or an email address. */
  participant(raw: string): string;
}

export function resolver(d: Directory | null | undefined): Resolver {
  const byKey = new Map<string, Person>();
  const byEmail = new Map<string, Person>();
  const byId = new Map<string, Person>();
  for (const p of d?.people ?? []) {
    byId.set(p.id, p);
    for (const k of keysOf(p)) if (!byKey.has(k)) byKey.set(k, p);
    if (p.email) byEmail.set(p.email.trim().toLowerCase(), p);
  }
  const lookup = (raw: string | null | undefined): Person | null => {
    if (!raw) return null;
    const t = raw.trim();
    if (t.includes("@")) {
      const e = byEmail.get(t.toLowerCase());
      if (e) return e;
      return byKey.get(nameKey(t.split("@")[0].replace(/[._]+/g, " "))) ?? null;
    }
    return byKey.get(nameKey(t)) ?? null;
  };
  return {
    lookup,
    item(i) {
      const movedTo = d?.moved[i.id];
      const moved = movedTo ? byId.get(movedTo) : undefined;
      if (!moved && isSpeakerLabel(i.person)) return unattributed(i);
      const p = moved ?? (i.person ? lookup(i.person) : null);
      if (!p) return i;
      const person = p.status === "confirmed" ? p.name : null;
      return { ...i, person, personRaw: i.person, personId: p.id };
    },
    participant(raw) {
      const p = lookup(raw);
      return p && p.status === "confirmed" ? p.name : raw;
    },
  };
}

/** An item named only by a speaker label: no person, the label replaced in its text. The raw name stays in personRaw. */
export function unattributed(i: Item): Item {
  return { ...i, person: null, personRaw: i.person, text: i.person ? unlabelText(i.text, i.person) : i.text, unattributed: true };
}

/** Resolve a list of items; the same array back when there is no directory and no speaker label. */
export function resolveItems(items: Item[], d: Directory | null | undefined): Item[] {
  if (isEmpty(d)) return items.some((i) => isSpeakerLabel(i.person)) ? items.map((i) => (isSpeakerLabel(i.person) ? unattributed(i) : i)) : items;
  const r = resolver(d);
  return items.map(r.item);
}

export function resolveMeeting<M extends Pick<Meeting, "participants">>(m: M, d: Directory | null | undefined): M {
  if (isEmpty(d) || !m.participants.length) return m;
  const r = resolver(d);
  return { ...m, participants: dedupe(m.participants.map(r.participant)) };
}

export function resolveUpcoming<M extends Pick<UpcomingMeeting, "attendees">>(m: M, d: Directory | null | undefined): M {
  if (isEmpty(d) || !m.attendees.length) return m;
  const r = resolver(d);
  return { ...m, attendees: dedupe(m.attendees.map(r.participant)) };
}

/** A calendar cache with every event's attendees resolved (a copy; the same object without a directory). */
export function resolveCalendar(c: CalendarCache | null, d: Directory | null | undefined): CalendarCache | null {
  if (!c || isEmpty(d)) return c;
  return { ...c, events: c.events.map((e) => resolveUpcoming(e, d)) };
}

const dedupe = (xs: string[]) => xs.filter((x, i) => xs.findIndex((y) => nameKey(y) === nameKey(x)) === i);

/** Confirmed people for the extraction prompt: "Mangku (also Mungu, Manku)". */
export function knownPeople(d: Directory | null | undefined, max = 150): Array<{ name: string; aliases: string[] }> {
  return confirmed(d)
    .map((p) => ({ name: p.name, aliases: p.aliases.filter((a) => nameKey(a) !== nameKey(p.name)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, max);
}

// ---------- changing ----------

/** A source or target of a change: a person in the directory, or a name not in it yet (with its spellings). */
export type NameRef = { personId: string } | { name: string; spellings?: string[] };

export interface ChangeCtx {
  newId: () => string;
  at: string;
}

/** Records puts and moves against a working copy, so a change can be planned before it is applied. */
class Tx {
  readonly ops: PeopleOp[] = [];
  readonly people: Map<string, Person>;
  readonly moved: Record<string, string>;
  constructor(d: Directory, readonly ctx: ChangeCtx) {
    this.people = new Map(d.people.map((p) => [p.id, clone(p)]));
    this.moved = { ...d.moved };
  }
  get(id: string) { return this.people.get(id) ?? null; }
  byKey(key: string): Person | null {
    for (const p of this.people.values()) if (keysOf(p).includes(key)) return p;
    return null;
  }
  put(after: Person) {
    const before = this.people.get(after.id) ?? null;
    this.ops.push({ t: "put", before: before && clone(before), after: clone(after) });
    this.people.set(after.id, clone(after));
  }
  remove(id: string) {
    const before = this.people.get(id);
    if (!before) return;
    this.ops.push({ t: "put", before: clone(before), after: null });
    this.people.delete(id);
  }
  move(itemId: string, to: string | null) {
    const before = this.moved[itemId] ?? null;
    if (before === to) return;
    this.ops.push({ t: "move", itemId, before, after: to });
    if (to) this.moved[itemId] = to;
    else delete this.moved[itemId];
  }
  /** Take these spellings off whoever has them (other than `keep`), deleting a person left with no name. */
  release(spellings: string[], keep?: string) {
    const keys = new Set(spellings.map(nameKey));
    for (const p of [...this.people.values()]) {
      if (p.id === keep) continue;
      if (!keysOf(p).some((k) => keys.has(k))) continue;
      const left = [p.name, ...p.aliases].filter((s) => !keys.has(nameKey(s)));
      if (!left.length) { this.remove(p.id); continue; }
      const name = keys.has(nameKey(p.name)) ? left[0] : p.name;
      this.put({ ...p, name, aliases: uniq(left.filter((s) => nameKey(s) !== nameKey(name))) });
    }
  }
  create(name: string, aliases: string[], status: PersonStatus, extra: Partial<Person> = {}): Person {
    const p: Person = { id: this.ctx.newId(), name: tidy(name), aliases: uniq(aliases.map(tidy).filter((a) => nameKey(a) && nameKey(a) !== nameKey(name))), status, createdAt: this.ctx.at, ...extra };
    this.put(p);
    return p;
  }
}

const clone = (p: Person): Person => ({ ...p, aliases: [...p.aliases] });
const uniq = (xs: string[]) => xs.filter((x, i) => xs.findIndex((y) => nameKey(y) === nameKey(x)) === i);

function finish(tx: Tx, label: string): PeopleChange | null {
  if (!tx.ops.length) return null;
  return { id: tx.ctx.newId(), at: tx.ctx.at, label, ops: tx.ops };
}

/** Resolve a target to a confirmed person in the transaction, creating it from a name when needed. */
function target(tx: Tx, t: NameRef): Person {
  if ("personId" in t) {
    const p = tx.get(t.personId);
    if (!p) throw new Error("That person is no longer in the directory.");
    if (p.status !== "confirmed") { tx.put({ ...p, status: "confirmed" }); return tx.get(p.id)!; }
    return p;
  }
  const spellings = uniq([t.name, ...(t.spellings ?? [])].map(tidy).filter((s) => nameKey(s)));
  if (!spellings.length) throw new Error("Give a name.");
  const existing = tx.byKey(nameKey(t.name));
  if (existing && existing.status === "confirmed") {
    addAliases(tx, existing, spellings);
    return tx.get(existing.id)!;
  }
  tx.release(spellings);
  return tx.create(t.name, spellings, "confirmed");
}

function addAliases(tx: Tx, p: Person, spellings: string[]) {
  tx.release(spellings, p.id);
  const cur = tx.get(p.id)!;
  const aliases = uniq([...cur.aliases, ...spellings].filter((s) => nameKey(s) !== nameKey(cur.name)));
  if (aliases.length !== cur.aliases.length || aliases.some((a, i) => a !== cur.aliases[i])) tx.put({ ...cur, aliases });
}

/**
 * "Same as": the source names mean the target person. A source person is folded into the target
 * (its name and aliases become aliases, its moved items follow); source spellings are added as aliases.
 */
export function merge(d: Directory, source: NameRef, into: NameRef, ctx: ChangeCtx): PeopleChange | null {
  const tx = new Tx(d, ctx);
  if ("personId" in source && "personId" in into && source.personId === into.personId) return null;
  const to = target(tx, into);
  if ("personId" in source) {
    const from = tx.get(source.personId);
    if (!from) throw new Error("That person is no longer in the directory.");
    const spellings = [from.name, ...from.aliases];
    tx.remove(from.id);
    addAliases(tx, tx.get(to.id)!, spellings);
    for (const [itemId, pid] of Object.entries(tx.moved)) if (pid === from.id) tx.move(itemId, to.id);
    const cur = tx.get(to.id)!;
    if (!cur.email && from.email) tx.put({ ...cur, email: from.email });
    if (!cur.note && from.note) tx.put({ ...tx.get(to.id)!, note: from.note });
    return finish(tx, `${from.name} is ${cur.name}`);
  }
  const spellings = uniq([source.name, ...(source.spellings ?? [])]);
  addAliases(tx, tx.get(to.id)!, spellings);
  return finish(tx, `${tidy(source.name)} is ${tx.get(to.id)!.name}`);
}

/** "New person": these spellings are one real person, shown as `name` (a rename when it differs). */
export function confirmNew(
  d: Directory,
  args: { name: string; spellings: string[]; email?: string | null; note?: string | null },
  ctx: ChangeCtx,
): PeopleChange | null {
  const name = tidy(args.name);
  if (!nameKey(name)) throw new Error("Give a name.");
  const tx = new Tx(d, ctx);
  const existing = tx.byKey(nameKey(name));
  const spellings = uniq([name, ...args.spellings]);
  if (existing && existing.status === "confirmed") {
    // Renamed to someone who already exists: that is a merge.
    addAliases(tx, existing, spellings);
    return finish(tx, `${tidy(args.spellings[0] ?? name)} is ${existing.name}`);
  }
  tx.release(spellings);
  const extra: Partial<Person> = {};
  if (args.email?.trim()) extra.email = args.email.trim();
  if (args.note?.trim()) extra.note = args.note.trim();
  tx.create(name, spellings, "confirmed", extra);
  const was = args.spellings[0] && nameKey(args.spellings[0]) !== nameKey(name) ? `${tidy(args.spellings[0])} renamed to ${name}` : `${name} added`;
  return finish(tx, was);
}

/** Confirm several names as they are, in one change (one Undo). */
export function confirmMany(d: Directory, names: Array<{ name: string; spellings: string[] }>, ctx: ChangeCtx): PeopleChange | null {
  const tx = new Tx(d, ctx);
  for (const n of names) {
    const name = tidy(n.name);
    if (!nameKey(name) || tx.byKey(nameKey(name))) continue;
    const spellings = uniq([name, ...n.spellings]);
    tx.release(spellings);
    tx.create(name, spellings, "confirmed");
  }
  const k = tx.ops.filter((o) => o.t === "put" && !o.before).length;
  return finish(tx, `${k} ${k === 1 ? "name" : "names"} confirmed as they are`);
}

/** "Not a person": these spellings are transcription noise. Their items show no name. */
export function ignoreNames(d: Directory, spellings: string[], ctx: ChangeCtx): PeopleChange | null {
  const s = uniq(spellings.map(tidy).filter((x) => nameKey(x)));
  if (!s.length) return null;
  const tx = new Tx(d, ctx);
  tx.release(s);
  tx.create(s[0], s, "ignored");
  return finish(tx, `${s[0]} ignored`);
}

/** Split: move these items to another person (or back to their own name with `null`). */
export function moveItems(d: Directory, itemIds: string[], to: NameRef | null, ctx: ChangeCtx): PeopleChange | null {
  const tx = new Tx(d, ctx);
  const p = to ? target(tx, to) : null;
  for (const id of itemIds) tx.move(id, p?.id ?? null);
  const n = itemIds.length;
  return finish(tx, `${n} ${n === 1 ? "item" : "items"} moved to ${p ? p.name : "their own name"}`);
}

/** Edit a person's name, email or note. The old name stays as an alias. */
export function editPerson(d: Directory, id: string, patch: { name?: string; email?: string | null; note?: string | null }, ctx: ChangeCtx): PeopleChange | null {
  const tx = new Tx(d, ctx);
  const p = tx.get(id);
  if (!p) throw new Error("That person is no longer in the directory.");
  const next: Person = { ...p };
  if (patch.name !== undefined && nameKey(patch.name) && tidy(patch.name) !== p.name) {
    const name = tidy(patch.name);
    const other = tx.byKey(nameKey(name));
    if (other && other.id !== p.id) throw new Error(`${other.name} already has that name. Merge instead.`);
    next.name = name;
    next.aliases = uniq([...p.aliases, p.name].filter((a) => nameKey(a) !== nameKey(name)));
  }
  if (patch.email !== undefined) next.email = patch.email?.trim() || null;
  if (patch.note !== undefined) next.note = patch.note?.trim() || null;
  if (JSON.stringify(next) === JSON.stringify(p)) return null;
  tx.put(next);
  return finish(tx, `${next.name} updated`);
}

/** Apply a change's ops to a directory (in place). */
export function applyOps(d: Directory, ops: PeopleOp[]): void {
  for (const op of ops) {
    if (op.t === "move") {
      if (op.after) d.moved[op.itemId] = op.after;
      else delete d.moved[op.itemId];
      continue;
    }
    const id = (op.after ?? op.before)!.id;
    const i = d.people.findIndex((p) => p.id === id);
    if (op.after) {
      if (i >= 0) d.people[i] = clone(op.after);
      else d.people.push(clone(op.after));
    } else if (i >= 0) d.people.splice(i, 1);
  }
}

/**
 * The ops that undo one change, even after later changes: each op is reversed only as far as the
 * directory still shows it. A person it created is removed; one it deleted comes back; for one it
 * edited, the aliases it added are taken off, the ones it removed come back, and any field still
 * holding the value it set gets the old value.
 */
export function undoOps(d: Directory, change: PeopleChange): PeopleOp[] {
  const out: PeopleOp[] = [];
  const work: Directory = { people: d.people.map(clone), moved: { ...d.moved } };
  const put = (before: Person | null, after: Person | null) => {
    const op: PeopleOp = { t: "put", before, after };
    out.push(op);
    applyOps(work, [op]);
  };
  for (const op of [...change.ops].reverse()) {
    if (op.t === "move") {
      if ((work.moved[op.itemId] ?? null) === op.after) {
        const m: PeopleOp = { t: "move", itemId: op.itemId, before: op.after, after: op.before };
        out.push(m);
        applyOps(work, [m]);
      }
      continue;
    }
    const id = (op.after ?? op.before)!.id;
    const cur = work.people.find((p) => p.id === id) ?? null;
    if (!op.before) {
      if (cur) put(cur, null);
      continue;
    }
    if (!op.after) {
      if (!cur) {
        // Its spellings may have gone to someone else since (the merge target): take them back.
        const keys = new Set(keysOf(op.before));
        for (const p of [...work.people]) {
          const left = p.aliases.filter((a) => !keys.has(nameKey(a)));
          if (left.length !== p.aliases.length && !keys.has(nameKey(p.name))) put(clone(p), { ...clone(p), aliases: left });
        }
        put(null, clone(op.before));
      }
      continue;
    }
    if (!cur) continue;
    const added = op.after.aliases.filter((a) => !op.before!.aliases.some((b) => nameKey(b) === nameKey(a)));
    const removed = op.before.aliases.filter((b) => !op.after!.aliases.some((a) => nameKey(a) === nameKey(b)));
    const next: Person = clone(cur);
    next.aliases = uniq([...cur.aliases.filter((a) => !added.some((x) => nameKey(x) === nameKey(a))), ...removed]);
    for (const f of ["name", "email", "note", "status"] as const) {
      if (cur[f] === op.after[f] && op.before[f] !== op.after[f]) (next as unknown as Record<string, unknown>)[f] = op.before[f];
    }
    if (nameKey(next.name) !== nameKey(cur.name)) next.aliases = next.aliases.filter((a) => nameKey(a) !== nameKey(next.name));
    if (JSON.stringify(next) !== JSON.stringify(cur)) put(clone(cur), next);
  }
  return out;
}
