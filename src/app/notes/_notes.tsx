// Notes in the reading pane: every note in the workspace folder grouped as Projects, People,
// Meetings and Daily, and the picked one in the detail with its editor, what's open from your
// meetings about it, and a rail with its outline, meetings and file. The workbench (tree, tabs,
// split) stays one click away.
import Link from "next/link";
import { redirect } from "next/navigation";
import { ExportMenu } from "@/components/ExportMenu";
import { Shell } from "@/components/Shell";
import { Chips, Detail, DetailBar, IRows, LinkGroups, ListBar, MList, NoneDetail, Sec, initials, type LinkGroup } from "@/components/reading/Frame";
import { NotePane } from "@/components/reading/NotePane";
import { blocksHtml } from "@/lib/export/html";
import { parseBlocks } from "@/lib/export/doc";
import { readProperties, type PropValue } from "@/lib/structure/frontmatter";
import { editedLabel, groupNotes, itemLine, noteGroupOf, type NoteEntry } from "@/lib/reading/library";
import { shortDay } from "@/lib/reading/model";
import { me } from "@/server/local/app";
import { notesDir } from "@/server/local/paths";
import { readVaultNote, walkVault } from "@/server/local/vault";
import { newNoteFormAction } from "../notes-actions";
import { loadAll } from "../_lib/lines";
import { readingCtx } from "../_lib/reading";
import { vaultContext } from "../_lib/vault";

const MAX_NOTES = 600;

export type NoteMode = "write" | "read";
export const noteMode = (v: string | undefined): NoteMode => (v === "read" ? "read" : "write");

const propText = (v: PropValue): string => (Array.isArray(v) ? v.join(", ") : v === null ? "" : String(v));
const propLabel = (k: string) => (k[0].toUpperCase() + k.slice(1)).replace(/[_-]+/g, " ");

export async function NotesPanes({ path, mode = "write" }: { path: string | null; mode?: NoteMode }) {
  const user = await me();
  if (!user) redirect("/setup");
  const root = notesDir();
  const now = new Date();
  const { files } = walkVault(root);
  const entries: NoteEntry[] = files.slice(0, MAX_NOTES).map((f) => {
    const n = readVaultNote(root, f.path);
    const props = n ? readProperties(n.markdown) : {};
    const t = typeof props.type === "string" ? props.type : null;
    const h1 = n ? /^# (.+)$/m.exec(n.markdown)?.[1]?.trim() : null;
    const title = typeof props.title === "string" && props.title ? props.title : h1 || (n?.name ?? f.path);
    return { path: f.path, title, type: t, updatedAt: new Date(f.mtimeMs).toISOString() };
  });
  const groups = groupNotes(entries);
  const { items, meetings } = await loadAll(user);
  const ctx = readingCtx(user, meetings, now);
  const sel = path ?? groups[0]?.notes[0]?.path ?? null;
  const slugOf = (p: string) => (/^notes\/[^/]+\.md$/i.test(p) ? p.replace(/^notes\//, "").replace(/\.md$/i, "") : null);
  const base = (p: string) => { const s = slugOf(p); return s ? `/notes/${encodeURIComponent(s)}` : `/notes/${p.split("/").map(encodeURIComponent).join("/")}`; };
  // Read mode follows you from note to note until you switch back to Write.
  const href = (p: string, m: NoteMode = mode) => `${base(p)}${m === "read" ? "?mode=read" : ""}`;
  const open = items.filter((i) => i.status === "open" && i.kind !== "decision");
  const liveFor = (n: NoteEntry) => {
    const g = noteGroupOf(n);
    const slug = slugOf(n.path);
    if (g === "projects" && slug) return open.filter((i) => i.project === slug);
    if (g === "people") { const first = n.title.toLowerCase().split(/\s+/)[0]; return open.filter((i) => i.person && i.person.toLowerCase().split(/\s+/)[0] === first); }
    return [];
  };

  const lgroups: LinkGroup[] = groups.map((g) => ({
    key: g.key, label: g.label,
    rows: g.notes.map((n) => {
      const live = liveFor(n).length;
      return {
        key: n.path, href: href(n.path), title: n.title, bold: true,
        av: g.key === "people" ? initials(n.title) : undefined, mark: g.key === "projects" ? "sq" : "dot",
        sub: [n.type ?? (g.key === "daily" ? "Daily" : "Note"), editedLabel(n.updatedAt, ctx)].filter(Boolean).join(" · "),
        badge: live ? `${live} open` : "",
      };
    }),
  }));
  const plus = (
    <form action={newNoteFormAction} className="rp-newnote">
      <input className="db-input" name="title" placeholder="New note" aria-label="New note title" maxLength={120} autoComplete="off" />
    </form>
  );
  const list = (
    <>
      <ListBar title="Notes" count={entries.length}>
        <Link className="rp-btn" href="/notes?view=files" title="The folder tree, tabs and split panes">Files</Link>
      </ListBar>
      {groups.length ? <Chips chips={groups.map((g) => ({ label: g.short, n: g.notes.length, href: `#rp-g-${g.key}` }))} /> : null}
      {plus}
      <LinkGroups groups={lgroups} sel={sel} foot={entries.length ? null : "No notes yet. Give the first one a title above."} />
    </>
  );

  let detail;
  const entry = sel ? entries.find((e) => e.path === sel) ?? { path: sel, title: sel.split("/").pop()!.replace(/\.md$/i, ""), type: null, updatedAt: null } : null;
  if (!entry) detail = <NoneDetail crumb={[{ label: "Notes" }]} listHref="/notes" text="No notes yet." />;
  else {
    const g = groups.find((x) => x.key === noteGroupOf(entry));
    const note = readVaultNote(root, entry.path);
    const outline = (note?.markdown ?? "").split("\n").filter((l) => /^#{1,3} /.test(l)).map((l) => l.replace(/^#+ /, "").trim()).slice(0, 12);
    const live = liveFor(entry);
    const ms = [...new Set(live.map((i) => i.meetingId))].map((id) => ctx.meetings.get(id)).filter((m) => !!m)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 4);
    const slug = slugOf(entry.path);
    const vctx = await vaultContext(user, now);
    detail = (
      <Detail
        bar={<DetailBar crumb={[{ label: "Notes", href: "/notes" }, ...(g ? [{ label: g.label }] : []), { label: entry.title }]} listHref="/notes"
          acts={<>
            <div className="rp-seg rp-seg--keep" role="group" aria-label="Write or read">
              <Link href={href(entry.path, "write")} aria-current={mode === "write" ? "true" : undefined} replace>Write</Link>
              <Link href={href(entry.path, "read")} aria-current={mode === "read" ? "true" : undefined} replace>Read</Link>
            </div>
            {slug ? <ExportMenu type="note" id={slug} label="Export" /> : null}
            <Link className="rp-btn" href={`/notes?view=files&open=${encodeURIComponent(entry.path)}`}>Open in tabs</Link>
          </>} />}
        rail={<>
          <Sec title="Outline"><MList rows={[...outline.map((h, k) => ({ key: `${k}`, label: h })), ...(live.length ? [{ key: "live", label: "From your meetings", right: live.length }] : [])]} empty="No headings yet." /></Sec>
          {ms.length ? <Sec title="Meetings about it"><MList rows={ms.map((m) => ({ key: m.id, label: m.title || "Meeting", right: shortDay(m.startedAt, user.timeZone), href: `/meeting/${encodeURIComponent(m.id)}` }))} /></Sec> : null}
          <p className="rp-note">Saved as {entry.path}. Edit it in any Markdown app and it stays in sync.</p>
        </>}
      >
        {mode === "read" ? <ReadNote markdown={note?.markdown ?? ""} title={entry.title} writeHref={href(entry.path, "write")} /> : <NotePane path={entry.path} ctx={vctx} />}
        {live.length ? (
          <div className="rp-live">
            <div className="rp-live__h"><span className="rp-m rp-m--owe" aria-hidden="true" />From your meetings · {live.length} open<span>Updates by itself</span></div>
            <IRows rows={live.map((i) => itemLine(i, ctx, `/item/${encodeURIComponent(i.id)}`))} />
          </div>
        ) : null}
      </Detail>
    );
  }
  return <Shell current="notes" list={list} detail={detail} show={path ? "detail" : "list"} />;
}

/** Read mode: the note as a page, with its properties as one quiet strip and nothing to edit. */
function ReadNote({ markdown, title, writeHref }: { markdown: string; title: string; writeHref: string }) {
  const props = Object.entries(readProperties(markdown)).filter(([k, v]) => k !== "title" && propText(v));
  const blocks = parseBlocks(markdown);
  const h = blocks[0];
  const hasTitle = h && h.t === "h" && h.level === 1;
  return (
    <article className="rp-read">
      {hasTitle ? null : <h1>{title}</h1>}
      {hasTitle ? <div dangerouslySetInnerHTML={{ __html: blocksHtml([h]) }} /> : null}
      {props.length ? <div className="rp-props">{props.map(([k, v]) => <span key={k}>{propLabel(k)} <b>{propText(v)}</b></span>)}</div> : null}
      {blocks.length > (hasTitle ? 1 : 0)
        // blocksHtml escapes every bit of text and keeps only safe link targets.
        ? <div className="rp-read__body" dangerouslySetInnerHTML={{ __html: blocksHtml(hasTitle ? blocks.slice(1) : blocks) }} />
        : <p className="rp-quiet">Nothing written yet. <Link href={writeHref} replace>Start writing</Link></p>}
    </article>
  );
}
