"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import type { CanvasDoc, CanvasNode, CanvasWindow, NodeAction } from "@/lib/canvas/model";
import { canvasAsk, canvasDone, canvasFinish, canvasNextWeek, canvasResolve, canvasStart, type AskResult, type StartKind } from "@/app/canvas-actions";

type Box = { x: number; y: number; w: number; h: number };
type View = { x: number; y: number; k: number };
const GAP = 18;
const INTERACTIVE = "a,button,input,textarea,select,label,[data-nodrag]";

function readLayout(id: string): Record<string, { x: number; y: number }> {
  try { return JSON.parse(localStorage.getItem(`db-canvas:${id}`) ?? "{}"); } catch { return {}; }
}
function writeLayout(id: string, v: Record<string, { x: number; y: number }>) {
  try { localStorage.setItem(`db-canvas:${id}`, JSON.stringify(v)); } catch { /* private mode: layout just isn't kept */ }
}

/** Where each card sits: its own x/y, stacked under the one before in its column, or where you dragged it. */
function layout(nodes: CanvasNode[], sizes: Record<string, { w: number; h: number }>, moved: Record<string, { x: number; y: number }>): Record<string, Box> {
  const out: Record<string, Box> = {};
  const lastInStack: Record<string, Box> = {};
  for (const n of nodes) {
    if (n.kind === "zone") continue;
    const h = sizes[n.id]?.h ?? 80;
    let y = n.y;
    if (n.stack && lastInStack[n.stack]) y = lastInStack[n.stack].y + lastInStack[n.stack].h + GAP;
    const b = { x: n.x, y, w: n.w, h };
    if (n.stack) lastInStack[n.stack] = b;
    out[n.id] = moved[n.id] ? { ...b, ...moved[n.id] } : b;
  }
  for (const n of nodes) {
    if (n.kind !== "zone") continue;
    const inner = n.holds ? lastInStack[n.holds] : null;
    out[n.id] = { x: n.x, y: n.y, w: n.w, h: Math.max(n.h ?? 120, inner ? inner.y + inner.h + 20 - n.y : 0) };
  }
  return out;
}

function edgePath(a: Box, b: Box): string {
  const ax = a.x + a.w / 2, ay = a.y + a.h / 2, bx = b.x + b.w / 2, by = b.y + b.h / 2;
  if (Math.abs(bx - ax) > Math.abs(by - ay) * 0.8 && (b.x > a.x + a.w || a.x > b.x + b.w)) {
    const sx = bx > ax ? a.x + a.w : a.x, ex = bx > ax ? b.x : b.x + b.w, m = (sx + ex) / 2;
    return `M${sx},${ay}C${m},${ay} ${m},${by} ${ex},${by}`;
  }
  const sy = by > ay ? a.y + a.h : a.y, ey = by > ay ? b.y : b.y + b.h, m = (sy + ey) / 2;
  return `M${ax},${sy}C${ax},${m} ${bx},${m} ${bx},${ey}`;
}

export function Board({ doc, windows = [] }: { doc: CanvasDoc; windows?: CanvasWindow[] }) {
  const router = useRouter();
  const wrap = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Record<string, { w: number; h: number }>>({});
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  const [fitted, setFitted] = useState(false);
  const [unplugged, setUnplugged] = useState<Set<string>>(new Set());
  const hasAsk = doc.nodes.some((n) => n.kind === "ask");
  const winById = useMemo(() => new Map(windows.map((w) => [`window:${w.id}`, w])), [windows]);

  useEffect(() => { setMoved(readLayout(doc.id)); setFitted(false); }, [doc.id]);

  // Measure every card after each render, so columns stack on real heights. It only sets state
  // when a height changed, so it settles after one extra render.
  const nodeEls = useRef(new Map<string, HTMLElement>());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const next: Record<string, { w: number; h: number }> = {};
    let changed = false;
    for (const [id, el] of nodeEls.current) {
      const s = { w: el.offsetWidth, h: el.offsetHeight };
      next[id] = s;
      if (!sizes[id] || sizes[id].h !== s.h) changed = true;
    }
    if (changed) setSizes(next);
  });

  const boxes = useMemo(() => layout(doc.nodes, sizes, moved), [doc.nodes, sizes, moved]);
  const world = useMemo(() => {
    const bs = Object.values(boxes);
    return { w: Math.max(400, ...bs.map((b) => b.x + b.w)) + 40, h: Math.max(300, ...bs.map((b) => b.y + b.h)) + 40 };
  }, [boxes]);

  const fit = useCallback(() => {
    const el = wrap.current;
    if (!el) return;
    const k = Math.max(0.25, Math.min(1, (el.clientWidth - 16) / world.w, (el.clientHeight - 16) / world.h));
    setView({ k, x: Math.max(8, (el.clientWidth - world.w * k) / 2), y: 8 });
  }, [world.w, world.h]);
  useEffect(() => { if (!fitted && Object.keys(sizes).length) { fit(); setFitted(true); } }, [fit, fitted, sizes]);

  // Wheel: pinch or ⌘/Ctrl zooms at the pointer; otherwise it pans.
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          const k = Math.min(2, Math.max(0.3, v.k * Math.exp(-e.deltaY * 0.01)));
          const px = e.clientX - r.left, py = e.clientY - r.top;
          return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
        }
        return { ...v, x: v.x - e.deltaX, y: v.y - e.deltaY };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const drag = useRef<null | { kind: "pan" | "node"; id?: string; sx: number; sy: number; ox: number; oy: number; movedPx: number }>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [, startT] = useTransition();

  const onDown = (e: RPointerEvent) => {
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    const card = (e.target as HTMLElement).closest<HTMLElement>("[data-node]");
    const id = card?.dataset.node;
    const n = id ? doc.nodes.find((x) => x.id === id) : null;
    if (n && n.kind !== "zone") {
      const b = boxes[n.id];
      drag.current = { kind: "node", id: n.id, sx: e.clientX, sy: e.clientY, ox: b.x, oy: b.y, movedPx: 0 };
      setDragging(n.id);
    } else {
      drag.current = { kind: "pan", sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y, movedPx: 0 };
    }
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    d.movedPx = Math.max(d.movedPx, Math.abs(dx) + Math.abs(dy));
    if (d.kind === "pan") setView((v) => ({ ...v, x: d.ox + dx, y: d.oy + dy }));
    else if (d.id) {
      const id = d.id;
      setMoved((m) => ({ ...m, [id]: { x: Math.round(d.ox + dx / view.k), y: Math.round(d.oy + dy / view.k) } }));
    }
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (!d || d.kind !== "node" || !d.id || d.movedPx < 4) return;
    const n = doc.nodes.find((x) => x.id === d.id);
    const b = boxes[d.id];
    const zone = doc.nodes.find((z) => z.kind === "zone" && z.drop && boxes[z.id] && b && inside(b, boxes[z.id]));
    if (n?.draggable && n.itemId && zone?.drop === "next-week") {
      const itemId = n.itemId;
      setMoved((m) => { const rest = { ...m }; delete rest[d.id!]; writeLayout(doc.id, rest); return rest; });
      startT(async () => { await canvasNextWeek(itemId); router.refresh(); });
      return;
    }
    setMoved((m) => { writeLayout(doc.id, m); return m; });
  };

  const zoomBy = (f: number) => {
    const el = wrap.current;
    if (!el) return;
    const px = el.clientWidth / 2, py = el.clientHeight / 2;
    setView((v) => { const k = Math.min(2, Math.max(0.3, v.k * f)); return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k }; });
  };
  const resetLayout = () => { setMoved({}); writeLayout(doc.id, {}); setFitted(false); };

  const askContext = useMemo(() => doc.nodes.filter((n) => n.context && !unplugged.has(n.id)), [doc.nodes, unplugged]);
  const toggle = (id: string) => setUnplugged((s) => { const t = new Set(s); if (t.has(id)) t.delete(id); else t.add(id); return t; });

  const edgeEls = doc.edges.map((e, k) => {
    const a = boxes[e.from], b = boxes[e.to];
    if (!a || !b) return null;
    const off = e.kind === "ctx" && (unplugged.has(e.from) || unplugged.has(e.to));
    return <path key={k} d={edgePath(a, b)} className={`cv-edge cv-edge--${off ? "off" : e.kind}`} />;
  });

  return (
    <div className="cv">
      <div className="cv-bar">
        <span className="cv-bar__meta">{doc.meta}</span>
        <span className="cv-bar__tools">
          {Object.keys(moved).length ? <button type="button" className="cv-tool" onClick={resetLayout}>Reset layout</button> : null}
          <button type="button" className="cv-tool" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
          <button type="button" className="cv-tool" onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
          <button type="button" className="cv-tool" onClick={fit}>Fit</button>
        </span>
      </div>
      <div ref={wrap} className="cv-stage" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="cv-world" style={{ width: world.w, height: world.h, transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {doc.nodes.filter((n) => n.kind === "zone").map((n) => (
            <div key={n.id} data-node={n.id} className={`cv-zone cv-zone--${n.tone || "quiet"}`} style={box(boxes[n.id])}>
              <b>{n.title}</b>{n.sub ? <small>{n.sub}</small> : null}
            </div>
          ))}
          <svg className="cv-lines" width={world.w} height={world.h} aria-hidden="true">{edgeEls}</svg>
          {doc.nodes.filter((n) => n.kind !== "zone").map((n) => (
            <div
              key={n.id}
              ref={(el) => { if (el) nodeEls.current.set(n.id, el); else nodeEls.current.delete(n.id); }}
              data-node={n.id}
              className={`cv-node cv-node--${n.kind}${n.done ? " is-done" : ""}${dragging === n.id ? " is-dragging" : ""}${hasAsk && n.context && unplugged.has(n.id) ? " is-off" : ""}`}
              style={{ left: boxes[n.id]?.x ?? n.x, top: boxes[n.id]?.y ?? n.y, width: n.w }}
            >
              <NodeBody n={n} win={winById.get(n.id)} askContext={askContext} onToggle={hasAsk && n.context ? () => toggle(n.id) : undefined} plugged={!unplugged.has(n.id)} />
            </div>
          ))}
        </div>
      </div>
      <p className="cv-hint">Drag the background to move around, pinch or ⌘-scroll to zoom, drag a card to move it.{doc.nodes.some((n) => n.drop) ? " Drop a card on Next week to move it there." : ""}</p>
    </div>
  );
}

const box = (b?: Box) => (b ? { left: b.x, top: b.y, width: b.w, height: b.h } : undefined);
const inside = (a: Box, z: Box) => a.x + a.w / 2 > z.x && a.x + a.w / 2 < z.x + z.w && a.y + 20 > z.y && a.y + 20 < z.y + z.h;

function NodeBody({ n, win, askContext, onToggle, plugged }: { n: CanvasNode; win?: CanvasWindow; askContext: CanvasNode[]; onToggle?: () => void; plugged: boolean }) {
  if (n.kind === "ask") return <AskNode n={n} context={askContext} />;
  if (n.kind === "window" && n.id === "launch") return <LaunchNode n={n} />;
  if (n.kind === "window" && win) return <WindowNode w={win} />;
  const title: ReactNode = n.href ? <Link href={n.href} className="cv-node__title">{n.title}</Link> : <span className="cv-node__title">{n.title}</span>;
  if (n.kind === "person") return <><i className="cv-avatar" aria-hidden="true">{initials(n.title)}</i>{title}</>;
  return (
    <>
      {n.label ? <span className="cv-node__label"><i className="cv-mark" aria-hidden="true" />{n.label}</span> : null}
      {title}
      {n.sub ? <span className="cv-node__sub">{n.sub}</span> : null}
      {n.quote ? <q className="cv-node__quote">{n.quote}</q> : null}
      {n.actions?.length ? <Actions actions={n.actions} /> : null}
      {onToggle ? (
        <button type="button" className={`cv-plug${plugged ? " is-on" : ""}`} onClick={onToggle} aria-pressed={plugged} title={plugged ? "Ask reads this. Click to leave it out." : "Left out of Ask. Click to plug it back in."}>
          {plugged ? "In context" : "Left out"}
        </button>
      ) : null}
    </>
  );
}

/** Claude's **bold** as bold; everything else as plain text. */
const bold = (s: string) => s.split(/\*\*(.+?)\*\*/g).map((p, k) => (k % 2 ? <b key={k}>{p}</b> : p));

const initials = (s: string) => s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

function Actions({ actions }: { actions: NodeAction[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (a: NodeAction) => start(async () => {
    if (a.type === "resolve") await canvasResolve(a.contradictionId, a.how);
    if (a.type === "next-week") await canvasNextWeek(a.itemId);
    if (a.type === "done") await canvasDone(a.itemId);
    router.refresh();
  });
  return (
    <span className="cv-actions">
      {actions.map((a, k) => a.type === "link"
        ? <Link key={k} className={`cv-btn${k ? "" : " cv-btn--p"}`} href={a.href}>{a.label}</Link>
        : <button key={k} type="button" disabled={pending} className={`cv-btn${k ? "" : " cv-btn--p"}`} onClick={() => run(a)}>{a.label}</button>)}
    </span>
  );
}

function AskNode({ n, context }: { n: CanvasNode; context: CanvasNode[] }) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<AskResult | null>(null);
  const [pending, start] = useTransition();
  const ask = (question: string) => start(async () => {
    setRes(await canvasAsk(n.sub ? `${n.sub}. ${question}` : question, context.filter((c) => c.itemId).map((c) => c.itemId!), context.filter((c) => c.meetingId && !c.itemId).map((c) => c.meetingId!)));
  });
  return (
    <>
      <span className="cv-win__head"><b>{n.label}</b><span>{context.length} in context</span></span>
      <form className="cv-ask" data-nodrag onSubmit={(e) => { e.preventDefault(); ask(q || n.title); }}>
        <input id="cv-ask-q" className="cv-ask__q" value={q} onChange={(e) => setQ(e.target.value)} placeholder={n.title} aria-label="Question" />
        <button type="submit" className="cv-btn cv-btn--p" disabled={pending || !context.length}>{pending ? "Asking…" : "Ask"}</button>
      </form>
      {res ? (res.ok ? <Answer r={res} /> : <p className="cv-err">{res.error}</p>) : <p className="cv-node__sub">Asks about the lime-linked cards only. Click “In context” on a card to leave it out.</p>}
    </>
  );
}

function Answer({ r }: { r: Extract<AskResult, { ok: true }> }) {
  const byN = new Map(r.sources.map((s) => [s.n, s]));
  const parts = r.text.split(/(\[\d+(?:,\s*\d+)*\])/g);
  return (
    <div className="cv-answer" data-nodrag><p className="cv-answer__text">
      {parts.map((p, k) => {
        const m = p.match(/^\[(\d+(?:,\s*\d+)*)\]$/);
        if (!m) return <span key={k}>{bold(p)}</span>;
        return <span key={k}>{m[1].split(/,\s*/).map(Number).map((x) => byN.get(x) ? <Link key={x} className="cv-cite" href={`/item/${encodeURIComponent(byN.get(x)!.itemId)}`} title={byN.get(x)!.title}>{x}</Link> : null)}</span>;
      })}
      </p><small className="cv-node__sub">Answered with {r.via}.</small>
    </div>
  );
}

const STARTS: Array<{ kind: StartKind; label: string }> = [
  { kind: "claude", label: "Claude" },
  { kind: "claude-code", label: "Claude Code" },
  { kind: "slack", label: "Slack draft" },
  { kind: "email", label: "Email draft" },
];

function LaunchNode({ n }: { n: CanvasNode }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [which, setWhich] = useState<StartKind | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const go = (k: StartKind) => { setWhich(k); setErr(null); start(async () => {
    const r = await canvasStart(n.itemId!, k);
    if (r.url) window.open(r.url, "_blank", "noopener");
    if (!r.ok && r.error) setErr(r.error);
    router.refresh();
  }); };
  return (
    <>
      <span className="cv-win__head"><b>{n.label}</b><span>reads everything linked on the left</span></span>
      <p className="cv-node__title">{n.title}</p>
      <span className="cv-actions" data-nodrag>
        {STARTS.map((s, k) => <button key={s.kind} type="button" className={`cv-btn${k ? "" : " cv-btn--p"}`} disabled={pending} onClick={() => go(s.kind)}>{pending && which === s.kind ? "Starting…" : s.label}</button>)}
      </span>
      {pending && which === "claude" ? <p className="cv-node__sub">Claude is working on it. This can take a minute.</p> : null}
      {err ? <p className="cv-err">{err}</p> : null}
    </>
  );
}

function WindowNode({ w }: { w: CanvasWindow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [copied, setCopied] = useState(false);
  const finish = (close: boolean) => start(async () => { await canvasFinish(w.id, close); router.refresh(); });
  const copy = async () => { try { await navigator.clipboard.writeText(w.output); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ } };
  const term = w.kind === "claude-code";
  return (
    <div className={term ? "cv-term" : undefined}>
      <span className="cv-win__head"><b>{w.title}</b><span>{w.status === "done" ? "done" : w.status === "error" ? "didn’t work" : w.status === "running" ? "working…" : "ready"}</span></span>
      <div className={`cv-win__out${w.status === "error" ? " cv-err" : ""}`} data-nodrag>{w.output ? bold(w.output) : "…"}</div>
      {w.status !== "done" ? (
        <span className="cv-actions" data-nodrag>
          {w.output && !term && w.status === "ready" ? <button type="button" className="cv-btn" onClick={copy}>{copied ? "Copied" : "Copy"}</button> : null}
          <button type="button" className="cv-btn cv-btn--p" disabled={pending} onClick={() => finish(true)}>Done, close the item</button>
          <button type="button" className="cv-btn" disabled={pending} onClick={() => finish(false)}>Done, keep it open</button>
        </span>
      ) : null}
    </div>
  );
}
