"use client";

// Ask: posts the question, reads the NDJSON stream from /api/ask, and renders the answer as it
// arrives, with [n] citations linking to the item or passage behind it. Conversations persist per
// workspace; from any answer, or any cited quote, you can branch a side thread without losing the
// main one. The thread tree (or, on a phone, the breadcrumbs) shows where you are.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { citedNumbers, parseCitations } from "@/lib/ask/cite";
import type { AskTurn } from "@/lib/ask/threads";
import type { ConversationRow, ThreadView } from "@/server/ask-threads";
import { branchAction, deleteThreadAction, openThreadAction, renameThreadAction } from "@/app/ask-actions";
import { Mark } from "./Mark";

interface ItemSrc {
  n: number; type?: "item"; itemId: string; kind: "owe" | "waiting" | "decision"; status: string; text: string;
  person: string | null; quote: string; closeQuote: string | null; meetingTitle: string; at: string; href: string;
}
interface PassageSrc { n: number; type: "meeting" | "transcript" | "note"; docId: string; title: string; text: string; at: string | null; href: string }
type Source = ItemSrc | PassageSrc;
interface Head { type: "sources"; sources: Source[]; estimate: { inputTokens: number; costInr: number | null }; model: string; providerLabel: string; how: string; threadId: string }
type Line = Head | { type: "text"; text: string } | { type: "done"; costInr: number | null; noAnswer: boolean } | { type: "error"; error: string };

const EXAMPLES = ["What do I owe this week?", "Who is late on something?", "What did we decide about the launch?"];
const isItem = (s: Source): s is ItemSrc => !s.type || s.type === "item";
const PASSAGE = { meeting: "Meeting", transcript: "Transcript", note: "Note" } as const;

function inr(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n < 0.01) return "under ₹0.01";
  return `₹${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
}
const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const KIND = { owe: "You owe", waiting: "Waiting on", decision: "Decision" } as const;
const HOW: Record<string, string> = { bm25: "searched on this Mac", "bm25+local-embeddings": "searched on this Mac with local embeddings", "bm25+remote-embeddings": "searched with embeddings from your provider" };
const modelName = (q: string) => q.replace(/^[a-z-]+:/, "");

type Live = { question: string; answer: string; sources: Source[]; state: "asking" | "done" | "error"; error: string | null; cost: number | null; est: number | null; model: string; how: string };

export function AskBox({ initial, ready, hint, conversations: initialConvs, view: initialView }: {
  initial: string;
  ready: boolean;
  hint: string;
  conversations: ConversationRow[];
  view: ThreadView | null;
}) {
  const [q, setQ] = useState(initial);
  const [view, setView] = useState<ThreadView | null>(initialView);
  const [convs, setConvs] = useState(initialConvs);
  const [live, setLive] = useState<Live | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDetailsElement>(null);
  // On a phone the conversation list starts folded, so the question comes first.
  useEffect(() => { if (window.matchMedia("(max-width: 900px)").matches && menu.current) menu.current.open = false; }, []);

  const go = useCallback(async (id: string | null, focus = false) => {
    setLive(null); setRenaming(false); setNote(null);
    const r = await openThreadAction(id ?? "");
    setConvs(r.conversations);
    setView(r.view);
    window.history.replaceState(null, "", r.view ? `/ask?t=${encodeURIComponent(r.view.id)}` : "/ask");
    if (focus) setTimeout(() => input.current?.focus(), 0);
  }, []);

  const ask = useCallback(async (question: string, threadId: string | null) => {
    const text = question.trim();
    if (!text) return;
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setQ("");
    setLive({ question: text, answer: "", sources: [], state: "asking", error: null, cost: null, est: null, model: "", how: "" });
    let tid: string | null = threadId;
    try {
      const r = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: text, ...(threadId ? { threadId } : {}) }), signal: c.signal });
      if (!r.ok || !r.body) {
        const e = await r.json().catch(() => ({ error: "Something went wrong." }));
        setLive((l) => l && { ...l, state: "error", error: e.error ?? "Something went wrong." });
        return;
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const raw = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!raw) continue;
          const ev = JSON.parse(raw) as Line;
          if (ev.type === "sources") { tid = ev.threadId; setLive((l) => l && { ...l, sources: ev.sources, est: ev.estimate.costInr, model: ev.model, how: ev.how }); }
          else if (ev.type === "text") setLive((l) => l && { ...l, answer: l.answer + ev.text });
          else if (ev.type === "done") setLive((l) => l && { ...l, cost: ev.costInr, state: "done" });
          else if (ev.type === "error") setLive((l) => l && { ...l, error: ev.error, state: "error" });
        }
      }
      // Saved by the server: show the thread as stored.
      if (tid) {
        const o = await openThreadAction(tid);
        setConvs(o.conversations);
        if (o.view) { setView(o.view); setLive(null); window.history.replaceState(null, "", `/ask?t=${encodeURIComponent(o.view.id)}`); }
      }
    } catch {
      if (!c.signal.aborted) setLive((l) => l && { ...l, state: "error", error: "Couldn't reach the app. Is it still running?" });
    }
  }, []);

  // Asked from the palette (/ask?q=…): ask straight away, as a new conversation.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initial && !initialView) void ask(initial, null); else input.current?.focus();
  }, [initial, initialView, ask]);
  useEffect(() => () => ctl.current?.abort(), []);
  useEffect(() => { if (live) end.current?.scrollIntoView({ block: "nearest" }); }, [live?.state, live]);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!q.trim() || live?.state === "asking") return;
    void ask(q, view?.id ?? null);
  };

  const doBranch = async (turnId: string, quote: string | null) => {
    if (!view) return;
    const r = await branchAction(view.id, turnId, quote);
    if (r.ok) await go(r.id, true); else setNote(r.error);
  };
  const doRename = async () => {
    if (!view || !name.trim()) { setRenaming(false); return; }
    await renameThreadAction(view.id, name);
    await go(view.id);
  };
  const doDelete = async () => {
    if (!view) return;
    const what = view.parentId ? "this branch and any branches made from it" : "this whole conversation, with all its branches";
    if (!window.confirm(`Delete ${what}?`)) return;
    const r = await deleteThreadAction(view.id);
    await go(r.next);
  };

  const branchName = view?.quote ? `“${view.quote.slice(0, 60)}${view.quote.length > 60 ? "…" : ""}”` : null;
  const empty = !view && !live;

  return (
    <div className="db-ask at">
      <aside className="at__rail" aria-label="Conversations">
        <details className="at__menu" open ref={menu}>
          <summary className="at__menu-sum">Conversations{convs.length ? ` (${convs.length})` : ""}</summary>
          <button type="button" className="db-btn at__new" onClick={() => go(null, true)}>New question</button>
          {convs.length ? (
            <ul className="at__convs">
              {convs.map((c) => (
                <li key={c.id}>
                  <button type="button" className={`at__conv${view?.rootId === c.id ? " at__conv--on" : ""}`} onClick={() => go(c.id)}>
                    <span className="at__conv-name">{c.name}</span>
                    <span className="at__conv-meta">{shortDate(c.updatedAt)}{c.branches ? ` · ${c.branches} branch${c.branches === 1 ? "" : "es"}` : ""}</span>
                  </button>
                  {view?.rootId === c.id && view.tree.length > 1 ? (
                    <ul className="at__tree" aria-label="Threads in this conversation">
                      {view.tree.map((n) => (
                        <li key={n.id} style={{ paddingLeft: `${n.depth * 14}px` }}>
                          <button type="button" className={`at__node${n.id === view.id ? " at__node--on" : ""}`} onClick={() => go(n.id)} aria-current={n.id === view.id ? "true" : undefined}>
                            <span aria-hidden="true">{n.depth ? "↳ " : ""}</span>{n.depth ? n.name : "Main thread"}<span className="at__conv-meta"> · {n.turns}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : <p className="at__empty">Your questions are kept here, per workspace.</p>}
        </details>
      </aside>

      <div className="at__main">
        {view ? (
          <nav className="at__crumbs" aria-label="Thread">
            <ol>
              {view.crumbs.map((c, i) => (
                <li key={c.id}>
                  {i === view.crumbs.length - 1 ? <span aria-current="page">{c.name}</span> : <button type="button" className="at__crumb" onClick={() => go(c.id)}>{c.name}</button>}
                </li>
              ))}
            </ol>
            <span className="at__crumb-acts">
              {renaming ? (
                <form className="at__rename" onSubmit={(e) => { e.preventDefault(); void doRename(); }}>
                  <input className="db-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Thread name" autoFocus />
                  <button className="db-act" type="submit">Save</button>
                  <button className="db-act" type="button" onClick={() => setRenaming(false)}>Cancel</button>
                </form>
              ) : (
                <>
                  <button type="button" className="db-act" onClick={() => { setName(view.name); setRenaming(true); }}>Rename</button>
                  <button type="button" className="db-act" onClick={doDelete}>{view.parentId ? "Delete branch" : "Delete"}</button>
                </>
              )}
            </span>
          </nav>
        ) : null}
        {note ? <p className="db-ask__error" role="alert">{note}</p> : null}

        {view?.inherited.length ? (
          <details className="at__inherited">
            <summary>Continues from {view.inherited.length} earlier answer{view.inherited.length === 1 ? "" : "s"} in {view.crumbs[view.crumbs.length - 2]?.name ?? "the main thread"}</summary>
            {view.inherited.map((t) => <TurnCard key={t.id} turn={t} onBranch={doBranch} muted />)}
          </details>
        ) : null}
        {branchName && !view?.turns.length ? <p className="at__quote">Branched from {branchName}. Ask a follow-up about it.</p> : null}

        {view?.turns.map((t) => <TurnCard key={t.id} turn={t} onBranch={doBranch} />)}
        {live ? <LiveCard live={live} /> : null}
        <div ref={end} />

        <form className="db-ask__form" onSubmit={submit}>
          <label className="db-ask__sr" htmlFor="db-ask-q">{view ? "Follow-up question" : "Your question"}</label>
          <textarea
            id="db-ask-q" ref={input} className="db-ask__input" rows={2} maxLength={500} value={q}
            placeholder={view ? (branchName ? "Ask about that quote…" : "Ask a follow-up…") : "What did we decide about the dividend banner?"}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
          />
          <div className="db-ask__bar">
            <span className="db-ask__hint">{hint}</span>
            <button className="db-ask__btn" type="submit" disabled={!q.trim() || live?.state === "asking" || !ready}>{live?.state === "asking" ? "Asking…" : view ? "Ask follow-up" : "Ask"}</button>
          </div>
        </form>

        {empty ? (
          <div className="db-ask__examples">
            {EXAMPLES.map((x) => <button key={x} type="button" className="db-act" onClick={() => { void ask(x, null); }}>{x}</button>)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function LiveCard({ live }: { live: Live }) {
  return (
    <section className="db-ask__result at__turn" aria-live="polite" aria-busy={live.state === "asking"}>
      <p className="db-ask__q">{live.question}</p>
      {live.answer ? <Answer text={live.answer} sources={live.sources} /> : live.state === "asking" ? (
        <div className="db-ask__loading"><span /><span /><span className="db-ask__sr">Thinking</span></div>
      ) : null}
      {live.error ? <p className="db-ask__error" role="alert">{live.error}</p> : null}
      <p className="db-ask__meta">
        {live.sources.length ? `From ${live.sources.length} source${live.sources.length === 1 ? "" : "s"}, ${HOW[live.how] ?? "searched on this Mac"}` : live.model ? "No matching items" : ""}
        {live.state === "done" && live.cost != null ? ` · cost ${inr(live.cost)}` : live.est != null && live.state === "asking" ? ` · about ${inr(live.est)}` : ""}
      </p>
    </section>
  );
}

function TurnCard({ turn, onBranch, muted }: { turn: AskTurn; onBranch: (turnId: string, quote: string | null) => void; muted?: boolean }) {
  const sources = turn.sources as unknown as Source[];
  const cited = citedNumbers(turn.answer, sources.length).map((n) => sources[n - 1]).filter(Boolean);
  return (
    <section className={`db-ask__result at__turn${muted ? " at__turn--muted" : ""}`}>
      <p className="db-ask__q">{turn.question}</p>
      {turn.answer ? <Answer text={turn.answer} sources={sources} /> : null}
      {turn.error ? <p className="db-ask__error">{turn.error}</p> : null}
      <p className="db-ask__meta">
        {sources.length ? `From ${sources.length} source${sources.length === 1 ? "" : "s"}` : "No matching items"}
        {turn.model ? ` · ${modelName(turn.model)}` : ""}{turn.costInr != null ? ` · cost ${inr(turn.costInr)}` : ""}
      </p>
      {cited.length ? (
        <ol className="db-ask__sources" aria-label="Sources">
          {cited.map((s) => {
            const quote = isItem(s) ? s.quote : s.text.slice(0, 280);
            return (
              <li key={s.n} className="db-ask__src">
                <span className="db-ask__n">{s.n}</span>
                <span className="db-ask__src-body">
                  {isItem(s) ? (
                    <>
                      <span className="db-ask__src-head">
                        <Mark kind={s.status === "done" ? "done" : s.kind} />
                        <Link className="db-ask__src-text" href={s.href}>{s.text}</Link>
                      </span>
                      <span className="db-ask__quote">&ldquo;{s.quote}&rdquo;</span>
                      <span className="db-ask__src-meta">{s.status === "done" ? "Closed" : KIND[s.kind]}{s.person ? ` · ${s.person}` : ""} · {s.meetingTitle}, {shortDate(s.at)}</span>
                    </>
                  ) : (
                    <>
                      <span className="db-ask__src-head"><Link className="db-ask__src-text" href={s.href}>{s.title}</Link></span>
                      <span className="db-ask__quote">&ldquo;{quote}{s.text.length > 280 ? "…" : ""}&rdquo;</span>
                      <span className="db-ask__src-meta">{PASSAGE[s.type]}{s.at ? ` · ${shortDate(s.at)}` : ""}</span>
                    </>
                  )}
                  <button type="button" className="at__branch-q" onClick={() => onBranch(turn.id, quote)}>Branch from this quote</button>
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {turn.answer && !turn.error ? (
        <div className="at__turn-acts">
          <button type="button" className="db-act" onClick={() => onBranch(turn.id, null)}>Branch from here</button>
        </div>
      ) : null}
    </section>
  );
}

/** Paragraphs and "- " bullets, with [n] as links to the source (the quote on hover). */
function Answer({ text, sources }: { text: string; sources: Source[] }) {
  const blocks: Array<{ list: boolean; lines: string[] }> = [];
  for (const raw of text.split("\n")) {
    const l = raw.trimEnd();
    if (!l.trim()) { blocks.push({ list: false, lines: [] }); continue; }
    const isLi = /^\s*[-*•]\s+/.test(l);
    const last = blocks[blocks.length - 1];
    if (last && last.list === isLi && last.lines.length) last.lines.push(isLi ? l.replace(/^\s*[-*•]\s+/, "") : l);
    else blocks.push({ list: isLi, lines: [isLi ? l.replace(/^\s*[-*•]\s+/, "") : l] });
  }
  const inline = (s: string, key: string) =>
    parseCitations(s, sources.length).map((p, k) => {
      if (p.type === "text") return <span key={`${key}-${k}`}>{p.text}</span>;
      const src = sources[p.n - 1];
      const title = isItem(src) ? `“${src.quote}” · ${src.meetingTitle}` : `${src.title}: “${src.text.slice(0, 160)}”`;
      return (
        <Link key={`${key}-${k}`} className="db-ask__cite" href={src.href} title={title} aria-label={`Source ${p.n}: ${isItem(src) ? src.text : src.title}`}>
          {p.n}
        </Link>
      );
    });
  return (
    <div className="db-ask__answer">
      {blocks.filter((b) => b.lines.length).map((b, i) =>
        b.list ? (
          <ul key={i}>{b.lines.map((l, j) => <li key={j}>{inline(l, `${i}-${j}`)}</li>)}</ul>
        ) : (
          <p key={i}>{inline(b.lines.join(" "), `${i}`)}</p>
        ),
      )}
    </div>
  );
}
