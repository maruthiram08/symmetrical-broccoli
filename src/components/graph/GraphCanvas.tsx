"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Simulation, SimulationLinkDatum, SimulationNodeDatum } from "d3-force";
import type { GraphData, GraphEdgeType, GraphNode } from "@/lib/graph/model";

type SimNode = GraphNode & SimulationNodeDatum & { r: number; deg: number };
type SimLink = SimulationLinkDatum<SimNode> & { type: GraphEdgeType };
interface View { x: number; y: number; k: number }
interface Colors { ink: string; muted: string; faint: string; border: string; strong: string; hl: string; onHl: string; late: string; bg: string; s200: string; s300: string; font: string }

const NODE_R: Record<GraphNode["type"], number> = { person: 7, meeting: 5.5, promise: 4.5, decision: 4.5, note: 5 };
const MAX_LABEL = 30;

/** Positions kept between filter changes, so nodes don't jump about. */
const remembered = new Map<string, { x: number; y: number }>();

function readColors(el: HTMLElement): Colors {
  const cs = getComputedStyle(el);
  const v = (n: string, f: string) => cs.getPropertyValue(n).trim() || f;
  return {
    ink: v("--ink", "#0a0a0a"), muted: v("--ink-muted", "#525252"), faint: v("--ink-faint", "#666"), border: v("--border", "#ececec"),
    strong: v("--border-strong", "#8a8a8a"), hl: v("--highlight", "#d6ff3d"), onHl: v("--on-highlight", "#0a0a0a"), late: v("--overdue", "#c4320a"),
    bg: v("--bg", "#fff"), s200: v("--surface-200", "#f2f2f2"), s300: v("--surface-300", "#e8e8e8"), font: getComputedStyle(document.body).fontFamily || "system-ui",
  };
}

const short = (s: string) => (s.length > MAX_LABEL ? `${s.slice(0, MAX_LABEL - 1)}…` : s);

/**
 * A force-directed graph on one canvas. d3-force is loaded only when a graph is shown. Drag to
 * pan, wheel or pinch to zoom, drag a node to move it; hover (or tap) for a preview, click (or tap
 * again) to open. Colours come from the theme's CSS variables, so dark mode and themes just work.
 */
export function GraphCanvas({ data, height, focus, compact = false, label }: { data: GraphData; height: number | string; focus?: string | null; compact?: boolean; label: string }) {
  const router = useRouter();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sim = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodes = useRef<SimNode[]>([]);
  const links = useRef<SimLink[]>([]);
  const neighbors = useRef<Map<string, Set<string>>>(new Map());
  const view = useRef<View>({ x: 0, y: 0, k: 1 });
  const size = useRef({ w: 0, h: 0 });
  const colors = useRef<Colors | null>(null);
  const hoverRef = useRef<SimNode | null>(null);
  const fitted = useRef(false);
  const frame = useRef(0);
  const [hover, setHover] = useState<{ node: SimNode; x: number; y: number; touch: boolean } | null>(null);
  const [ready, setReady] = useState(false);

  // ---------- drawing ----------
  const draw = useCallback(() => {
    frame.current = 0;
    const cv = canvas.current;
    const c = colors.current;
    if (!cv || !c) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size.current;
    const t = view.current;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const hv = hoverRef.current;
    const near = hv ? neighbors.current.get(hv.id) : null;
    const lit = (id: string) => !hv || id === hv.id || !!near?.has(id);

    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.scale(t.k, t.k);
    // Edges, batched by look: quiet lines, darker for who-owes-whom, bright for the hovered node.
    const groups: Array<{ color: string; alpha: number; width: number; dash?: number[]; test: (l: SimLink, s: SimNode, d: SimNode) => boolean }> = [
      { color: c.strong, alpha: hv ? 0.12 : 0.45, width: 1, test: (l, s, d) => l.type !== "owes" && l.type !== "owed" && !(hv && (s === hv || d === hv)) },
      { color: c.muted, alpha: hv ? 0.15 : 0.7, width: 1.25, test: (l, s, d) => (l.type === "owes" || l.type === "owed") && !(hv && (s === hv || d === hv)) },
      { color: c.ink, alpha: 0.95, width: 1.5, test: (_l, s, d) => !!hv && (s === hv || d === hv) },
    ];
    for (const g of groups) {
      ctx.beginPath();
      for (const l of links.current) {
        const s = l.source as SimNode, d = l.target as SimNode;
        if (s.x == null || d.x == null || !g.test(l, s, d)) continue;
        ctx.moveTo(s.x, s.y!);
        ctx.lineTo(d.x, d.y!);
      }
      ctx.globalAlpha = g.alpha;
      ctx.strokeStyle = g.color;
      ctx.lineWidth = g.width / t.k;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // Nodes, shaped like the app's marks: owe = lime square, waiting = ring, decision = diamond, overdue = red.
    for (const n of nodes.current) {
      if (n.x == null) continue;
      ctx.globalAlpha = lit(n.id) ? (n.open ? 1 : 0.45) : 0.18;
      shape(ctx, n, c, t.k);
    }
    ctx.globalAlpha = 1;
    if (focus) {
      const f = nodes.current.find((n) => n.id === focus);
      if (f?.x != null) {
        ctx.beginPath();
        ctx.arc(f.x, f.y!, f.r + 5 / t.k, 0, Math.PI * 2);
        ctx.strokeStyle = c.ink;
        ctx.lineWidth = 1.5 / t.k;
        ctx.stroke();
      }
    }
    ctx.restore();

    // Labels in screen pixels, so they stay crisp at any zoom.
    ctx.font = `500 11px ${c.font}`;
    ctx.textBaseline = "middle";
    const few = nodes.current.length <= 40;
    for (const n of nodes.current) {
      if (n.x == null) continue;
      const show = (hv && lit(n.id)) || n.id === focus
        || (!hv && (n.type === "person" ? t.k >= 0.6 || few : (n.type === "meeting" || n.type === "note") ? t.k >= 1.5 || (compact && few) : t.k >= 2.6));
      if (!show) continue;
      const sx = n.x * t.k + t.x + n.r * t.k + 5, sy = n.y! * t.k + t.y;
      if (sx < -200 || sx > w + 10 || sy < -10 || sy > h + 10) continue;
      const text = short(n.label);
      ctx.globalAlpha = lit(n.id) ? 1 : 0.3;
      ctx.lineWidth = 3;
      ctx.strokeStyle = c.bg;
      ctx.strokeText(text, sx, sy);
      ctx.fillStyle = n.type === "person" || n.id === hv?.id ? c.ink : c.muted;
      ctx.fillText(text, sx, sy);
    }
    ctx.globalAlpha = 1;
  }, [focus, compact]);

  const request = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  const fit = useCallback((animate = false) => {
    const ns = nodes.current.filter((n) => n.x != null);
    const { w, h } = size.current;
    if (!ns.length || !w || !h) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) { x0 = Math.min(x0, n.x!); y0 = Math.min(y0, n.y!); x1 = Math.max(x1, n.x!); y1 = Math.max(y1, n.y!); }
    const pad = compact ? 28 : 48;
    const k = Math.max(0.15, Math.min(compact ? 1.6 : 2.2, (w - pad * 2) / Math.max(1, x1 - x0), (h - pad * 2) / Math.max(1, y1 - y0)));
    const target = { k, x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
    if (!animate || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      view.current = target;
      request();
      return;
    }
    const from = { ...view.current };
    const start = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / 260);
      const e = 1 - (1 - p) ** 3;
      view.current = { k: from.k + (target.k - from.k) * e, x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e };
      draw();
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [compact, draw, request]);

  // ---------- size and colours ----------
  useEffect(() => {
    const el = wrap.current, cv = canvas.current;
    if (!el || !cv) return;
    colors.current = readColors(el);
    const resize = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const prev = size.current;
      size.current = { w: r.width, h: r.height };
      cv.width = Math.round(r.width * dpr);
      cv.height = Math.round(r.height * dpr);
      cv.style.width = `${r.width}px`;
      cv.style.height = `${r.height}px`;
      if (prev.w) { view.current.x += (r.width - prev.w) / 2; view.current.y += (r.height - prev.h) / 2; }
      draw();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    const recolor = () => { colors.current = readColors(el); request(); };
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", recolor);
    const mo = new MutationObserver(recolor);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => { ro.disconnect(); mq.removeEventListener("change", recolor); mo.disconnect(); };
  }, [draw, request]);

  // ---------- the simulation (d3-force, loaded on first use) ----------
  useEffect(() => {
    let cancelled = false;
    const deg = new Map<string, number>();
    for (const e of data.edges) { deg.set(e.source, (deg.get(e.source) ?? 0) + 1); deg.set(e.target, (deg.get(e.target) ?? 0) + 1); }
    const ns: SimNode[] = data.nodes.map((n) => {
      const d = deg.get(n.id) ?? 0;
      const r = n.type === "person" ? Math.min(14, NODE_R.person + Math.sqrt(d) * 1.2) : n.type === "meeting" ? Math.min(9, NODE_R.meeting + Math.sqrt(d) * 0.5) : NODE_R[n.type];
      const p = remembered.get(n.id);
      return { ...n, r, deg: d, ...(p ? { x: p.x, y: p.y } : {}) };
    });
    const byId = new Map(ns.map((n) => [n.id, n]));
    const nb = new Map<string, Set<string>>();
    const ls: SimLink[] = [];
    for (const e of data.edges) {
      const s = byId.get(e.source), t = byId.get(e.target);
      if (!s || !t) continue;
      ls.push({ source: s, target: t, type: e.type });
      (nb.get(s.id) ?? nb.set(s.id, new Set()).get(s.id)!).add(t.id);
      (nb.get(t.id) ?? nb.set(t.id, new Set()).get(t.id)!).add(s.id);
    }
    nodes.current = ns;
    links.current = ls;
    neighbors.current = nb;
    hoverRef.current = null;
    setHover(null);
    const known = ns.filter((n) => n.x != null).length;
    const fresh = known < ns.length * 0.5;
    if (fresh) fitted.current = false;

    import("d3-force").then((d3) => {
      if (cancelled) return;
      sim.current?.stop();
      const big = ns.length > 250;
      const s = d3.forceSimulation<SimNode, SimLink>(ns)
        .force("link", d3.forceLink<SimNode, SimLink>(ls).distance((l) => (l.type === "met" ? 70 : l.type === "link" ? 55 : 38)).strength((l) => (l.type === "met" ? 0.08 : 0.45)))
        .force("charge", d3.forceManyBody<SimNode>().strength((n) => (n.type === "person" ? -140 : compact ? -45 : -60)).distanceMax(compact ? 260 : 420).theta(big ? 1 : 0.9))
        .force("collide", d3.forceCollide<SimNode>((n) => n.r + 2).iterations(1))
        .force("x", d3.forceX<SimNode>(0).strength(compact ? 0.08 : 0.045))
        .force("y", d3.forceY<SimNode>(0).strength(compact ? 0.1 : 0.06))
        .alphaDecay(big ? 0.045 : 0.03)
        .stop();
      if (!fresh) s.alpha(0.3);
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      // Settle most of the way before the first frame; the rest animates.
      s.tick(reduce ? 300 : fresh ? (big ? 70 : 120) : 10);
      sim.current = s;
      if (!fitted.current) { fit(false); fitted.current = true; }
      draw();
      setReady(true);
      if (reduce) return;
      s.on("tick", request).on("end", () => {
        for (const n of ns) if (n.x != null) remembered.set(n.id, { x: n.x, y: n.y! });
      }).restart();
    });
    return () => {
      cancelled = true;
      for (const n of nodes.current) if (n.x != null) remembered.set(n.id, { x: n.x, y: n.y! });
      sim.current?.stop();
    };
  }, [data, compact, draw, fit, request]);

  // ---------- pointer: pan, zoom, drag, hover, open ----------
  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let mode: "none" | "pan" | "node" | "pinch" = "none";
    let dragNode: SimNode | null = null;
    let downAt = { x: 0, y: 0 };
    let moved = 0;
    let pinch = { d: 0, k: 1, cx: 0, cy: 0, vx: 0, vy: 0 };
    let selected: SimNode | null = null;

    const local = (e: PointerEvent | WheelEvent) => {
      const r = cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const hit = (x: number, y: number): SimNode | null => {
      const t = view.current;
      const wx = (x - t.x) / t.k, wy = (y - t.y) / t.k;
      let best: SimNode | null = null, bd = Infinity;
      const slop = 6 / t.k;
      for (const n of nodes.current) {
        if (n.x == null) continue;
        const d = Math.hypot(n.x - wx, n.y! - wy);
        if (d < n.r + slop && d < bd) { best = n; bd = d; }
      }
      return best;
    };
    const showHover = (n: SimNode | null, touch: boolean) => {
      if (hoverRef.current?.id === n?.id) return;
      hoverRef.current = n;
      cv.style.cursor = n ? "pointer" : mode === "pan" ? "grabbing" : "grab";
      const t = view.current;
      setHover(n && n.x != null ? { node: n, x: n.x * t.k + t.x, y: n.y! * t.k + t.y, touch } : null);
      request();
    };
    const zoomAt = (x: number, y: number, factor: number) => {
      const t = view.current;
      const k = Math.max(0.1, Math.min(6, t.k * factor));
      view.current = { k, x: x - ((x - t.x) * k) / t.k, y: y - ((y - t.y) * k) / t.k };
      if (hoverRef.current) showHover(null, false);
      request();
    };

    const down = (e: PointerEvent) => {
      const p = local(e);
      pointers.set(e.pointerId, p);
      cv.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: view.current.k, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, vx: view.current.x, vy: view.current.y };
        mode = "pinch";
        if (dragNode) { dragNode.fx = dragNode.fy = null; dragNode = null; }
        return;
      }
      downAt = p;
      moved = 0;
      const n = hit(p.x, p.y);
      if (n) {
        mode = "node";
        dragNode = n;
      } else {
        mode = "pan";
        cv.style.cursor = "grabbing";
      }
    };
    const move = (e: PointerEvent) => {
      const p = local(e);
      const prev = pointers.get(e.pointerId);
      if (!prev) {
        if (e.pointerType === "mouse") showHover(hit(p.x, p.y), false);
        return;
      }
      pointers.set(e.pointerId, p);
      moved = Math.max(moved, Math.hypot(p.x - downAt.x, p.y - downAt.y));
      if (mode === "pinch" && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        const k = Math.max(0.1, Math.min(6, (pinch.k * d) / Math.max(1, pinch.d)));
        const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
        view.current = { k, x: cx - ((pinch.cx - pinch.vx) * k) / pinch.k, y: cy - ((pinch.cy - pinch.vy) * k) / pinch.k };
        request();
      } else if (mode === "pan") {
        view.current = { ...view.current, x: view.current.x + p.x - prev.x, y: view.current.y + p.y - prev.y };
        if (moved > 3 && hoverRef.current) showHover(null, false);
        request();
      } else if (mode === "node" && dragNode && moved > 3) {
        const t = view.current;
        dragNode.fx = (p.x - t.x) / t.k;
        dragNode.fy = (p.y - t.y) / t.k;
        sim.current?.alphaTarget(0.25).restart();
        if (hoverRef.current) showHover(null, false);
        request();
      }
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (mode === "pinch") { if (!pointers.size) mode = "none"; return; }
      const wasNode = mode === "node" ? dragNode : null;
      if (dragNode) {
        dragNode.fx = dragNode.fy = null;
        sim.current?.alphaTarget(0);
        dragNode = null;
      }
      mode = "none";
      cv.style.cursor = "grab";
      if (moved > 4) return;
      const tapped = wasNode ?? null;
      if (e.pointerType === "mouse") {
        if (tapped) router.push(tapped.href);
        return;
      }
      // Touch: the first tap shows the preview, a second tap on the same node opens it.
      if (tapped && selected?.id === tapped.id) router.push(tapped.href);
      else { selected = tapped; hoverRef.current = null; showHover(tapped, true); }
    };
    const leave = (e: PointerEvent) => { if (e.pointerType === "mouse" && !pointers.size) showHover(null, false); };
    const wheel = (e: WheelEvent) => {
      // In a page's small graph, plain scrolling scrolls the page; pinch (ctrl) or ⌘ zooms.
      if (compact && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const p = local(e);
      zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
    };
    cv.addEventListener("pointerdown", down);
    cv.addEventListener("pointermove", move);
    cv.addEventListener("pointerup", up);
    cv.addEventListener("pointercancel", up);
    cv.addEventListener("pointerleave", leave);
    cv.addEventListener("wheel", wheel, { passive: false });
    return () => {
      cv.removeEventListener("pointerdown", down);
      cv.removeEventListener("pointermove", move);
      cv.removeEventListener("pointerup", up);
      cv.removeEventListener("pointercancel", up);
      cv.removeEventListener("pointerleave", leave);
      cv.removeEventListener("wheel", wheel);
    };
  }, [compact, request, router]);

  const zoomBy = (f: number) => {
    const { w, h } = size.current;
    const t = view.current;
    const k = Math.max(0.1, Math.min(6, t.k * f));
    view.current = { k, x: w / 2 - ((w / 2 - t.x) * k) / t.k, y: h / 2 - ((h / 2 - t.y) * k) / t.k };
    request();
  };

  const tip = hover ? placeTip(hover.x, hover.y, size.current.w) : null;
  return (
    <div className={`gr-canvas${compact ? " gr-canvas--compact" : ""}`} ref={wrap} style={{ height }} data-ready={ready ? "" : undefined} data-nodes={data.nodes.length}>
      <canvas ref={canvas} role="img" aria-label={label} style={{ cursor: "grab", touchAction: "none" }} />
      {!ready ? <p className="gr-canvas__loading">Drawing the graph…</p> : null}
      <div className="gr-zoom">
        <button type="button" className="gr-zoom__b" aria-label="Zoom in" onClick={() => zoomBy(1.3)}>+</button>
        <button type="button" className="gr-zoom__b" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.3)}>−</button>
        <button type="button" className="gr-zoom__b gr-zoom__fit" aria-label="Fit to view" onClick={() => fit(true)}>Fit</button>
      </div>
      {hover && tip ? (
        <div className="gr-tip" role="tooltip" style={{ left: tip.left, top: tip.top, transform: tip.above ? "translateY(-100%)" : undefined }}>
          <span className="gr-tip__kind"><NodeMark node={hover.node} />{kindWord(hover.node)}</span>
          <strong className="gr-tip__title">{hover.node.label}</strong>
          {hover.node.sub ? <span className="gr-tip__sub">{hover.node.sub}</span> : null}
          {hover.node.detail ? <span className="gr-tip__detail">{hover.node.detail}</span> : null}
          {hover.touch ? <a className="db-act gr-tip__open" href={hover.node.href} onClick={(e) => { e.preventDefault(); router.push(hover.node.href); }}>Open</a> : null}
        </div>
      ) : null}
    </div>
  );
}

function placeTip(x: number, y: number, w: number) {
  const width = Math.min(280, w - 16);
  const left = Math.max(8, Math.min(x + 14, w - width - 8));
  const above = y > 170;
  return { left, top: above ? y - 12 : y + 14, above };
}

export function kindWord(n: Pick<GraphNode, "type" | "kind" | "overdue" | "open">): string {
  if (n.type === "promise") return `${n.kind === "owe" ? "You owe" : "Waiting on"}${n.overdue ? " · late" : n.open ? "" : " · done"}`;
  if (n.type === "decision") return n.open ? "Decision" : "Decision · closed";
  return n.type === "person" ? "Person" : n.type === "meeting" ? "Meeting" : "Note";
}

export function NodeMark({ node }: { node: Pick<GraphNode, "type" | "kind" | "overdue" | "open"> }) {
  if (node.type === "promise") return <span className={`db-mark db-mark--${!node.open ? "done" : node.overdue ? "overdue" : node.kind === "owe" ? "owe" : "waiting"}`} aria-hidden="true" />;
  if (node.type === "decision") return <span className="db-mark db-mark--decision" aria-hidden="true" />;
  return <span className={`gr-mark gr-mark--${node.type}`} aria-hidden="true" />;
}

function shape(ctx: CanvasRenderingContext2D, n: SimNode, c: Colors, k: number) {
  const x = n.x!, y = n.y!, r = n.r;
  const lw = 1.25 / k;
  ctx.lineWidth = lw;
  switch (n.type) {
    case "person":
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = c.s300;
      ctx.fill();
      ctx.strokeStyle = c.ink;
      ctx.stroke();
      break;
    case "meeting":
      ctx.beginPath();
      roundRect(ctx, x - r, y - r * 0.75, r * 2, r * 1.5, r * 0.35);
      ctx.fillStyle = c.bg;
      ctx.fill();
      ctx.strokeStyle = c.muted;
      ctx.stroke();
      break;
    case "note":
      ctx.beginPath();
      roundRect(ctx, x - r * 0.75, y - r, r * 1.5, r * 2, r * 0.2);
      ctx.fillStyle = c.s200;
      ctx.fill();
      ctx.strokeStyle = c.ink;
      ctx.stroke();
      break;
    case "decision":
      ctx.beginPath();
      ctx.moveTo(x, y - r * 1.15); ctx.lineTo(x + r * 1.15, y); ctx.lineTo(x, y + r * 1.15); ctx.lineTo(x - r * 1.15, y); ctx.closePath();
      ctx.fillStyle = n.open ? c.ink : c.faint;
      ctx.fill();
      break;
    case "promise":
      if (!n.open) {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.85, 0, Math.PI * 2);
        ctx.fillStyle = c.faint;
        ctx.fill();
      } else if (n.overdue) {
        ctx.beginPath();
        roundRect(ctx, x - r, y - r, r * 2, r * 2, r * 0.6);
        ctx.fillStyle = c.late;
        ctx.fill();
      } else if (n.kind === "owe") {
        ctx.beginPath();
        roundRect(ctx, x - r, y - r, r * 2, r * 2, r * 0.6);
        ctx.fillStyle = c.hl;
        ctx.fill();
        ctx.strokeStyle = c.ink;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(x, y, r * 0.9, 0, Math.PI * 2);
        ctx.fillStyle = c.bg;
        ctx.fill();
        ctx.lineWidth = 1.6 / k;
        ctx.strokeStyle = c.muted;
        ctx.stroke();
      }
      break;
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
