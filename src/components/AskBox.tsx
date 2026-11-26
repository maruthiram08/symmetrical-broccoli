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

export function AskBox({ initial, ready, hint, conversations: initialConvs, view: initialView, panes }: {
  initial: string;
  /** The reading pane: conversations in the list, the chat in the detail with a rail. */
  panes?: { model: string };
  ready: boolean;
  hint: string;
  conversations: ConversationRow[];
  view: ThreadView | null;
}) {
  const [q, setQ] = useState(initial);
  const [qNew, setQNew] = useState("");
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

  if (panes) {
    const turns = view ? [...view.inherited, ...view.turns] : [];
    const srcs = turns.flatMap((t) => t.sources as unknown as Source[]).concat(live?.sources ?? []);
    const read = new Map<string, string>();
    for (const x of srcs) { const t = isItem(x) ? x.meetingTitle : x.title; const at = isItem(x) ? x.at : x.at; if (t && !read.has(t)) read.set(t, at ? shortDate(at) : ""); }
    const cost = turns.reduce((a, t) => a + (t.costInr ?? 0), 0) + (live?.cost ?? 0);
    const cited = new Set(turns.flatMap((t) => citedNumbers(t.answer, (t.sources as unknown[]).length).map((n) => `${t.id}:${n}`))).size;
    const today = new Date().toDateString();
    const groups = [
      { label: "Today", rows: convs.filter((c) => new Date(c.updatedAt).toDateString() === today) },
      { label: "Earlier", rows: convs.filter((c) => new Date(c.updatedAt).toDateString() !== today) },
    ].filter((g) => g.rows.length);
    const asking = live?.state === "asking";
    const newQ = (e?: React.FormEvent) => { e?.preventDefault(); if (!qNew.trim() || asking) return; const x = qNew; setQNew(""); setView(null); void ask(x, null); };
    return (
      <div className="rp-panes" data-show={view || live ? "detail" : "list"}>
        <section className="rp-list" aria-label="Questions"><div className="rp-wrap">
          <div className="rp-bar"><h1 className="rp-h1">Ask</h1><span className="rp-n">About your meetings</span></div>
          <form className="rp-lcomp" onSubmit={newQ}>
            <div className="rp-composer">
              <textarea rows={1} maxLength={500} value={qNew} placeholder="Ask anything…" aria-label="New question" onChange={(e) => setQNew(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) { e.preventDefault(); newQ(); } }} />
              <span className="rp-kbd" aria-hidden="true">↵</span>
              <button className="rp-sendb" type="submit" aria-label="Ask" disabled={!qNew.trim() || asking || !ready}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg></button>
            </div>
          </form>
          <div className="rp-scroll">
            {groups.map((g) => (
              <section key={g.label} aria-label={g.label}>
                <h2 className="rp-gh">{g.label}<span className="rp-gh__n">{g.rows.length}</span></h2>
                {g.rows.map((c) => {
                  const on = view?.rootId === c.id;
                  return (
                    <div key={c.id}>
                      <div className={`rp-lrow${on ? " rp-row--sel" : ""}`}>
                        <span className="rp-m rp-m--ring" aria-hidden="true" />
                        <div className="rp-lrow__body">
                          <button type="button" className="rp-lrow__t rp-lrow__btn" onClick={() => go(c.id)}>{c.name}</button>
                          <div className="rp-lrow__s">{c.branches ? `${c.branches} branch${c.branches === 1 ? "" : "es"}` : "One thread"}</div>
                        </div>
                        <span className="rp-badge">{shortDate(c.updatedAt)}</span>
                      </div>
                      {on && view && view.tree.length > 1 ? view.tree.map((n) => (
                        <button key={n.id} type="button" className={`rp-tnode${n.id === view.id ? " rp-tnode--on" : ""}`} style={{ paddingLeft: `${46 + n.depth * 14}px` }} onClick={() => go(n.id)} aria-current={n.id === view.id ? "true" : undefined}>
                          {n.depth ? `↳ ${n.name}` : "Main thread"}<span> · {n.turns}</span>
                        </button>
                      )) : null}
                    </div>
                  );
                })}
              </section>
            ))}
            {convs.length ? null : <p className="rp-lfoot">Your questions are kept here, per workspace.</p>}
          </div>
        </div></section>
        <section className="rp-det" aria-label="Answer"><div className="rp-wrap">
          <div className="rp-bar rp-bar--det">
            <div className="rp-crumb">
              <button type="button" className="rp-back rp-back--list" onClick={() => { setLive(null); void go(null); }}>Back</button>
              <span className="rp-crumb__page">Ask<span aria-hidden="true" className="rp-crumb__sep">›</span></span>
              {view ? view.crumbs.slice(0, -1).map((c) => <span key={c.id} className="rp-crumb__page"><button type="button" className="rp-crumb__btn" onClick={() => go(c.id)}>{c.name}</button><span aria-hidden="true">›</span></span>) : null}
              <b>{view ? view.crumbs[view.crumbs.length - 1]?.name : live ? live.question : "New question"}</b>
            </div>
            {view ? (
              <div className="rp-acts">
                {renaming ? (
                  <form className="at__rename" onSubmit={(e) => { e.preventDefault(); void doRename(); }}>
                    <input className="db-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} aria-label="Thread name" autoFocus />
                    <button className="rp-btn" type="submit">Save</button>
                  </form>
                ) : (
                  <>
                    <button type="button" className="rp-btn" onClick={() => { setName(view.name); setRenaming(true); }}>Rename</button>
                    <button type="button" className="rp-btn" onClick={doDelete}>{view.parentId ? "Delete branch" : "Delete"}</button>
                  </>
                )}
              </div>
            ) : null}
          </div>
          <div className="rp-chatwrap">
            <div className="rp-chatcol">
              <div className="rp-chatscroll">
                <div className="rp-chat">
                  {note ? <p className="db-ask__error" role="alert">{note}</p> : null}
                  {view?.inherited.length ? (
                    <details className="at__inherited">
                      <summary>Continues from {view.inherited.length} earlier answer{view.inherited.length === 1 ? "" : "s"} in {view.crumbs[view.crumbs.length - 2]?.name ?? "the main thread"}</summary>
                      {view.inherited.map((t) => <TurnCard key={t.id} turn={t} onBranch={doBranch} muted chat />)}
                    </details>
                  ) : null}
                  {branchName && !view?.turns.length ? <p className="at__quote">Branched from {branchName}. Ask a follow-up about it.</p> : null}
                  {view?.turns.map((t) => <TurnCard key={t.id} turn={t} onBranch={doBranch} chat />)}
                  {live ? <LiveCard live={live} chat /> : null}
                  {empty ? (
                    <div className="rp-chat__empty">
                      <p>Ask about what was promised, decided and said. Answers come only from your meetings and notes, with the source behind each one.</p>
                      <div className="db-ask__examples">{EXAMPLES.map((x) => <button key={x} type="button" className="rp-btn" onClick={() => { void ask(x, null); }}>{x}</button>)}</div>
                    </div>
                  ) : null}
                  <div ref={end} />
                </div>
              </div>
              <form className="rp-chatfoot" onSubmit={submit}>
                <div className="rp-composer">
                  <label className="db-ask__sr" htmlFor="db-ask-q">{view ? "Follow-up question" : "Your question"}</label>
                  <textarea id="db-ask-q" ref={input} rows={1} maxLength={500} value={q}
                    placeholder={view ? (branchName ? "Ask about that quote…" : "Ask a follow-up…") : "What did we decide about the dividend banner?"}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />
                  <span className="rp-kbd" aria-hidden="true">↵</span>
                  <button className="rp-sendb" type="submit" aria-label={view ? "Ask follow-up" : "Ask"} disabled={!q.trim() || asking || !ready}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7" /></svg></button>
                </div>
                <p className="rp-chathint">{hint}</p>
              </form>
            </div>
            <aside className="rp-rail" aria-label="About this chat">
              <section className="rp-sec"><h2>Read from</h2>
                {read.size ? <div className="rp-mlist">{[...read].slice(0, 6).map(([t, d]) => <div key={t}><span>{t}</span><span>{d}</span></div>)}</div> : <p className="rp-quiet">Nothing yet. Each answer reads only the passages it needs.</p>}
              </section>
              <section className="rp-sec"><h2>This chat</h2>
                <dl className="rp-kv">
                  <div className="rp-kv__r"><dt>Model</dt><dd>{turns.find((t) => t.model)?.model ? modelName(turns.find((t) => t.model)!.model!) : live?.model ? modelName(live.model) : panes.model}</dd></div>
                  <div className="rp-kv__r"><dt>Cost</dt><dd>{cost ? `About ${inr(cost)}` : "Nothing yet"}</dd></div>
                  <div className="rp-kv__r"><dt>Items</dt><dd>{cited} cited</dd></div>
                </dl>
              </section>
              <section className="rp-sec"><h2>Try asking</h2>
                <div className="rp-sugg">{EXAMPLES.map((x) => <button key={x} type="button" onClick={() => { void ask(x, null); }}>{x}</button>)}</div>
              </section>
            </aside>
          </div>
        </div></section>
      </div>
    );
  }

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

function LiveCard({ live, chat }: { live: Live; chat?: boolean }) {
  return (
    <section className={`db-ask__result at__turn${chat ? " rp-turn" : ""}`} aria-live="polite" aria-busy={live.state === "asking"}>
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

function TurnCard({ turn, onBranch, muted, chat }: { turn: AskTurn; onBranch: (turnId: string, quote: string | null) => void; muted?: boolean; chat?: boolean }) {
  const sources = turn.sources as unknown as Source[];
  const cited = citedNumbers(turn.answer, sources.length).map((n) => sources[n - 1]).filter(Boolean);
  return (
    <section className={`db-ask__result at__turn${muted ? " at__turn--muted" : ""}${chat ? " rp-turn" : ""}`}>
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
