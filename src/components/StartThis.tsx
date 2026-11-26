"use client";

// "Start this": the button sits with Done/Wrong; the panel and the "Started in ..." line sit
// below the item. They share open/closed state through a tiny per-item store.
// Nothing is sent from here: the user copies a draft or opens Slack, Mail or Claude and sends it.
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, useTransition, type ReactNode } from "react";
import { draftHandoffAction, markStartedAction } from "@/app/handoff-actions";
import { SLACK_URL, claudeUrl, mailtoUrl } from "@/lib/handoff/links";
import type { Drafts, HandoffTarget } from "@/lib/handoff/types";

// ---------- per-item open state ----------

const openItems = new Set<string>();
const listeners = new Set<() => void>();
/** Open an item's Start this panel from elsewhere (the reading pane's "Get it done" rows), on a tab. */
export function openHandoff(id: string, tab?: HandoffTarget) {
  setOpen(id, true);
  if (tab) window.dispatchEvent(new CustomEvent(HANDOFF_TAB, { detail: { id, tab } }));
}
const HANDOFF_TAB = "db:handoff-tab";
function setOpen(id: string, open: boolean) {
  if (open) openItems.add(id);
  else openItems.delete(id);
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
function useOpen(id: string): boolean {
  return useSyncExternalStore(subscribe, () => openItems.has(id), () => false);
}

const panelId = (itemId: string) => `db-handoff-${itemId}`;

export function StartThisButton({ itemId }: { itemId: string }) {
  const open = useOpen(itemId);
  return (
    <button
      type="button"
      className="db-act db-act--start"
      aria-expanded={open}
      aria-controls={panelId(itemId)}
      onClick={() => setOpen(itemId, !open)}
    >
      Start this
    </button>
  );
}

// ---------- clipboard ----------

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    ta.remove();
    return ok;
  }
}

// ---------- panel ----------

const TABS: Array<{ id: HandoffTarget; label: string }> = [
  { id: "slack", label: "Slack message" },
  { id: "email", label: "Email" },
  { id: "claude", label: "Claude" },
];

export function HandoffPanel({ itemId, kind, person, started, extra }: { itemId: string; kind: "owe" | "waiting"; person: string | null; started: string | null; extra?: ReactNode }) {
  const open = useOpen(itemId);
  const [tab, setTab] = useState<HandoffTarget>("slack");
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slack, setSlack] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [pack, setPack] = useState("");
  const [startedLine, setStartedLine] = useState<string | null>(started);
  const [flash, setFlash] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const requested = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const uid = useId();

  // Asked for a tab (Get it done › Hand to Claude): show it.
  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent<{ id: string; tab: HandoffTarget }>).detail; if (d.id === itemId) setTab(d.tab); };
    window.addEventListener(HANDOFF_TAB, on);
    return () => window.removeEventListener(HANDOFF_TAB, on);
  }, [itemId]);

  // Draft once, the first time the panel opens (one Claude call per click, never on page load).
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    startTransition(async () => {
      const r = await draftHandoffAction(itemId);
      if (!r.ok) { setError(r.error); requested.current = false; return; }
      setDrafts(r.drafts);
      setSlack(r.drafts.slack);
      setSubject(r.drafts.emailSubject);
      setBody(r.drafts.emailBody);
      setPack(r.drafts.claudePrompt);
    });
  }, [open, itemId]);

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [open]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(t);
  }, [flash]);

  const mark = useCallback((target: HandoffTarget, how: "copy" | "open") => {
    void markStartedAction(itemId, target, how).then((line) => { if (line) setStartedLine(line); });
  }, [itemId]);

  const copy = async (target: HandoffTarget, text: string) => {
    const ok = await copyText(text);
    setFlash(ok ? "Copied" : "Couldn't copy. Select the text and copy it.");
    if (ok) mark(target, "copy");
  };

  const onTabKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + (e.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length];
    setTab(next.id);
    e.preventDefault();
    panelRef.current?.querySelector<HTMLElement>(`#${CSS.escape(`${uid}-tab-${next.id}`)}`)?.focus();
  };

  const source = tab === "slack" ? drafts?.slackSource : tab === "email" ? drafts?.emailSource : undefined;
  const who = person ?? "them";
  const hint = kind === "waiting" ? `A nudge to ${who}.` : `For ${who}: the deliverable or a status update.`;

  return (
    <div className="db-handoff">
      {startedLine ? <p className="db-handoff__started">{startedLine}</p> : null}
      {open ? (
        <div
          id={panelId(itemId)}
          ref={panelRef}
          className="db-handoff__panel"
          role="region"
          aria-label="Start this"
          onKeyDown={(e) => { if (e.key === "Escape") setOpen(itemId, false); }}
        >
          <div className="db-handoff__head">
            <div className="db-handoff__tabs" role="tablist" aria-label="Where to start" onKeyDown={onTabKey}>
              {TABS.map((t) => (
                <button
                  key={t.id}
                  id={`${uid}-tab-${t.id}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  aria-controls={`${uid}-body`}
                  tabIndex={tab === t.id ? 0 : -1}
                  className="db-handoff__tab"
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <button type="button" className="db-handoff__close" aria-label="Close" onClick={() => setOpen(itemId, false)}>
              Close
            </button>
          </div>

          <div id={`${uid}-body`} role="tabpanel" aria-labelledby={`${uid}-tab-${tab}`} className="db-handoff__body">
            {error ? (
              <p className="db-handoff__note">{error}</p>
            ) : !drafts || pending ? (
              <div className="db-handoff__loading" aria-live="polite">
                <span className="db-handoff__shimmer" />
                <span className="db-handoff__shimmer db-handoff__shimmer--short" />
                <span className="db-handoff__sr">Drafting</span>
              </div>
            ) : tab === "slack" ? (
              <>
                <label className="db-handoff__label" htmlFor={`${uid}-slack`}>{hint}</label>
                <textarea id={`${uid}-slack`} className="db-handoff__text" rows={4} value={slack} onChange={(e) => setSlack(e.target.value)} />
                <div className="db-handoff__acts">
                  <button type="button" className="db-handoff__btn db-handoff__btn--primary" onClick={() => copy("slack", slack)}>Copy</button>
                  <a
                    className="db-handoff__btn"
                    href={SLACK_URL}
                    onClick={() => { void copyText(slack); setFlash("Copied. Paste it in Slack."); mark("slack", "open"); }}
                  >
                    Open Slack
                  </a>
                </div>
              </>
            ) : tab === "email" ? (
              <>
                <label className="db-handoff__label" htmlFor={`${uid}-subject`}>Subject</label>
                <input id={`${uid}-subject`} className="db-handoff__input" value={subject} onChange={(e) => setSubject(e.target.value)} />
                <label className="db-handoff__label db-handoff__label--sr" htmlFor={`${uid}-body-text`}>Message</label>
                <textarea id={`${uid}-body-text`} className="db-handoff__text" rows={7} value={body} onChange={(e) => setBody(e.target.value)} />
                <div className="db-handoff__acts">
                  <a className="db-handoff__btn db-handoff__btn--primary" href={mailtoUrl(subject, body)} onClick={() => mark("email", "open")}>
                    Open in Mail
                  </a>
                  <button type="button" className="db-handoff__btn" onClick={() => copy("email", body)}>Copy</button>
                </div>
              </>
            ) : (
              <>
                <label className="db-handoff__label" htmlFor={`${uid}-pack`}>Context for Claude: the item, the quote, the meeting and other open items with {who}.</label>
                <textarea id={`${uid}-pack`} className="db-handoff__text db-handoff__text--mono" rows={9} value={pack} onChange={(e) => setPack(e.target.value)} />
                <div className="db-handoff__acts">
                  <button type="button" className="db-handoff__btn db-handoff__btn--primary" onClick={() => copy("claude", pack)}>Copy</button>
                  <a
                    className="db-handoff__btn"
                    href={claudeUrl(pack)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => { void copyText(pack); mark("claude", "open"); }}
                  >
                    Open Claude
                  </a>
                </div>
              </>
            )}
          </div>

          {extra}
          <p className="db-handoff__foot" aria-live="polite">
            {flash ?? (source === "template" ? "Template draft. Edit it before you send." : "Nothing is sent from here. You send it.")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
