"use client";

// The Ask box: posts the question, reads the NDJSON stream from /api/ask, and renders the answer
// as it arrives, with [n] citations linking to the item and the quote behind it.
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { citedNumbers, parseCitations } from "@/lib/ask/cite";
import { Mark } from "./Mark";

interface Source {
  n: number; itemId: string; kind: "owe" | "waiting" | "decision"; status: string; text: string;
  person: string | null; quote: string; closeQuote: string | null; meetingTitle: string; at: string; href: string;
}
interface Head { type: "sources"; sources: Source[]; estimate: { inputTokens: number; costInr: number | null }; model: string }
type Line = Head | { type: "text"; text: string } | { type: "done"; costInr: number | null; noAnswer: boolean } | { type: "error"; error: string };

const EXAMPLES = ["What do I owe this week?", "Who is late on something?", "What did we decide about the launch?"];

function inr(n: number | null | undefined): string | null {
  if (n == null) return null;
  if (n < 0.01) return "under ₹0.01";
  return `₹${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
}
const shortDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const KIND = { owe: "You owe", waiting: "Waiting on", decision: "Decision" } as const;

export function AskBox({ initial, hasKey }: { initial: string; hasKey: boolean }) {
  const [q, setQ] = useState(initial);
  const [asked, setAsked] = useState("");
  const [head, setHead] = useState<Head | null>(null);
  const [answer, setAnswer] = useState("");
  const [state, setState] = useState<"idle" | "asking" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [cost, setCost] = useState<number | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const ask = useCallback(async (question: string) => {
    const text = question.trim();
    if (!text) return;
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setAsked(text); setHead(null); setAnswer(""); setError(null); setCost(null); setState("asking");
    try {
      const r = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ q: text }), signal: c.signal });
      if (!r.ok || !r.body) {
        const e = await r.json().catch(() => ({ error: "Something went wrong." }));
        setError(e.error ?? "Something went wrong."); setState("error"); return;
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
          if (ev.type === "sources") setHead(ev);
          else if (ev.type === "text") setAnswer((a) => a + ev.text);
          else if (ev.type === "done") { setCost(ev.costInr); setState("done"); }
          else if (ev.type === "error") { setError(ev.error); setState("error"); }
        }
      }
      setState((s) => (s === "asking" ? "done" : s));
    } catch {
      if (!c.signal.aborted) { setError("Couldn't reach the app. Is it still running?"); setState("error"); }
    }
  }, []);

  // Asked from the palette (/ask?q=…): ask straight away.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initial) void ask(initial); else input.current?.focus();
  }, [initial, ask]);
  useEffect(() => () => ctl.current?.abort(), []);

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const t = q.trim();
    if (!t) return;
    window.history.replaceState(null, "", `/ask?q=${encodeURIComponent(t)}`);
    void ask(t);
  };

  const sources = head?.sources ?? [];
  const cited = citedNumbers(answer, sources.length).map((n) => sources[n - 1]).filter(Boolean);
  const est = inr(head?.estimate.costInr);

  return (
    <div className="db-ask">
      <form className="db-ask__form" onSubmit={submit}>
        <label className="db-ask__sr" htmlFor="db-ask-q">Your question</label>
        <textarea
          id="db-ask-q" ref={input} className="db-ask__input" rows={2} maxLength={500} value={q}
          placeholder="What did we decide about the dividend banner?"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        />
        <div className="db-ask__bar">
          <span className="db-ask__hint">{hasKey ? "Sends the question and up to 40 matching items to Claude. Never transcripts." : "Add ANTHROPIC_API_KEY to ask questions."}</span>
          <button className="db-ask__btn" type="submit" disabled={!q.trim() || state === "asking"}>{state === "asking" ? "Asking…" : "Ask"}</button>
        </div>
      </form>

      {!asked ? (
        <div className="db-ask__examples">
          {EXAMPLES.map((x) => (
            <button key={x} type="button" className="db-act" onClick={() => { setQ(x); window.history.replaceState(null, "", `/ask?q=${encodeURIComponent(x)}`); void ask(x); }}>{x}</button>
          ))}
        </div>
      ) : (
        <section className="db-ask__result" aria-live="polite" aria-busy={state === "asking"}>
          <p className="db-ask__q">{asked}</p>
          {answer ? <Answer text={answer} sources={sources} /> : state === "asking" ? (
            <div className="db-ask__loading"><span /><span /><span className="db-ask__sr">Thinking</span></div>
          ) : null}
          {error ? <p className="db-ask__error" role="alert">{error}</p> : null}
          <p className="db-ask__meta">
            {head ? `${sources.length ? `From ${sources.length} item${sources.length === 1 ? "" : "s"}` : "No matching items"}` : ""}
            {state === "done" && cost != null ? ` · cost ${inr(cost)}` : est && state === "asking" ? ` · about ${est}` : ""}
          </p>
          {cited.length ? (
            <ol className="db-ask__sources" aria-label="Sources">
              {cited.map((s) => (
                <li key={s.n} id={`db-src-${s.n}`} className="db-ask__src">
                  <span className="db-ask__n">{s.n}</span>
                  <span className="db-ask__src-body">
                    <span className="db-ask__src-head">
                      <Mark kind={s.status === "done" ? "done" : s.kind} />
                      <Link className="db-ask__src-text" href={s.href}>{s.text}</Link>
                    </span>
                    <span className="db-ask__quote">&ldquo;{s.quote}&rdquo;</span>
                    <span className="db-ask__src-meta">{s.status === "done" ? "Closed" : KIND[s.kind]}{s.person ? ` · ${s.person}` : ""} · {s.meetingTitle}, {shortDate(s.at)}</span>
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      )}
    </div>
  );
}

/** Paragraphs and "- " bullets, with [n] as links to the item (the quote on hover). */
function Answer({ text, sources }: { text: string; sources: Source[] }) {
  const blocks: Array<{ list: boolean; lines: string[] }> = [];
  for (const raw of text.split("\n")) {
    const l = raw.trimEnd();
    if (!l.trim()) { blocks.push({ list: false, lines: [] }); continue; }
    const isItem = /^\s*[-*•]\s+/.test(l);
    const last = blocks[blocks.length - 1];
    if (last && last.list === isItem && last.lines.length) last.lines.push(isItem ? l.replace(/^\s*[-*•]\s+/, "") : l);
    else blocks.push({ list: isItem, lines: [isItem ? l.replace(/^\s*[-*•]\s+/, "") : l] });
  }
  const inline = (s: string, key: string) =>
    parseCitations(s, sources.length).map((p, k) => {
      if (p.type === "text") return <span key={`${key}-${k}`}>{p.text}</span>;
      const src = sources[p.n - 1];
      return (
        <Link key={`${key}-${k}`} className="db-ask__cite" href={src.href} title={`“${src.quote}” · ${src.meetingTitle}`} aria-label={`Source ${p.n}: ${src.text}`}>
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
