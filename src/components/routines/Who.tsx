/** A routine's title with its person: bold where the title names them, else after a dot. */
export function TitleWithPerson({ title, person }: { title: string; person: string | null }) {
  if (!person) return <>{title}</>;
  const at = title.toLowerCase().indexOf(person.toLowerCase());
  if (at < 0) return <>{title} · <b>{person}</b></>;
  return <>{title.slice(0, at)}<b>{title.slice(at, at + person.length)}</b>{title.slice(at + person.length)}</>;
}
