"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { NODE_LABELS, NODE_TYPES, RANGES, filterGraph, rangeFrom, type GraphData, type GraphNodeType, type RangeId } from "@/lib/graph/model";
import { GraphCanvas, NodeMark, kindWord } from "./GraphCanvas";

const RANGE_LABELS: Record<RangeId, string> = { "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days", "365d": "Last year", all: "All time" };

export interface GraphViewState {
  types: GraphNodeType[];
  person: string | null;
  open: boolean;
  range: RangeId;
}

/** Filters (type, person, open only, time range), the graph, a legend and the same nodes as a list. */
export function GraphView({ data, initial, focus, now }: { data: GraphData; initial: GraphViewState; focus: string | null; now: string }) {
  const [s, setS] = useState(initial);
  const people = useMemo(() => data.nodes.filter((n) => n.type === "person").sort((a, b) => a.label.localeCompare(b.label)), [data]);
  const shown = useMemo(
    () => filterGraph(data, { types: s.types, person: s.person, openOnly: s.open, from: rangeFrom(s.range, new Date(now)) }),
    [data, s, now],
  );

  // Keep the filters in the address, so a reload or a shared link shows the same graph.
  useEffect(() => {
    const q = new URLSearchParams();
    if (s.types.length !== NODE_TYPES.length) q.set("types", s.types.join(","));
    if (s.person) q.set("person", s.person.replace(/^person:/, ""));
    if (!s.open) q.set("open", "0");
    if (s.range !== "all") q.set("range", s.range);
    if (focus) q.set("focus", focus);
    const next = `${location.pathname}${q.size ? `?${q}` : ""}`;
    if (next !== `${location.pathname}${location.search}`) history.replaceState(history.state, "", next);
  }, [s, focus]);

  const toggle = (t: GraphNodeType) =>
    setS((x) => {
      const on = x.types.includes(t);
      const types = on ? x.types.filter((y) => y !== t) : NODE_TYPES.filter((y) => y === t || x.types.includes(y));
      return { ...x, types: types.length ? types : x.types };
    });

  const counts = useMemo(() => {
    const c = Object.fromEntries(NODE_TYPES.map((t) => [t, 0])) as Record<GraphNodeType, number>;
    for (const n of shown.nodes) c[n.type]++;
    return c;
  }, [shown]);

  return (
    <div className="gr">
      <div className="gr-filters" role="group" aria-label="Filters">
        <div className="gr-chips" role="group" aria-label="Show">
          {NODE_TYPES.map((t) => (
            <button key={t} type="button" className="gr-chip" aria-pressed={s.types.includes(t)} onClick={() => toggle(t)}>
              <NodeMark node={t === "promise" ? { type: t, kind: "owe", open: true } : { type: t, open: true }} />
              {NODE_LABELS[t]}
            </button>
          ))}
        </div>
        <div className="gr-controls">
          <label className="gr-select">
            <span className="gr-select__label">Person</span>
            <select className="db-input" value={s.person ?? ""} onChange={(e) => setS((x) => ({ ...x, person: e.target.value || null }))}>
              <option value="">Everyone</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </label>
          <label className="gr-select">
            <span className="gr-select__label">When</span>
            <select className="db-input" value={s.range} onChange={(e) => setS((x) => ({ ...x, range: e.target.value as RangeId }))}>
              {(Object.keys(RANGES) as RangeId[]).map((r) => <option key={r} value={r}>{RANGE_LABELS[r]}</option>)}
            </select>
          </label>
          <label className="db-check gr-open">
            <input className="db-switch" type="checkbox" checked={s.open} onChange={(e) => setS((x) => ({ ...x, open: e.target.checked }))} />
            <span><span className="db-check__label">Open only</span></span>
          </label>
        </div>
      </div>

      <p className="gr-count" aria-live="polite">
        <span className="db-mono">{shown.nodes.length}</span> nodes · <span className="db-mono">{shown.edges.length}</span> links
        {s.person ? <> · around {people.find((p) => p.id === s.person)?.label ?? "them"}</> : null}
      </p>

      {shown.nodes.length ? (
        <GraphCanvas data={shown} height="min(72vh, 760px)" focus={focus ?? s.person} label={`Graph of ${shown.nodes.length} people, meetings, promises, decisions and notes`} />
      ) : (
        <p className="gr-empty">Nothing matches these filters. Try All time, or turn off Open only.</p>
      )}

      <ul className="gr-legend" aria-label="Legend">
        <li><span className="db-mark db-mark--owe" />You owe</li>
        <li><span className="db-mark db-mark--waiting" />Waiting on</li>
        <li><span className="db-mark db-mark--overdue" />Late</li>
        <li><span className="db-mark db-mark--decision" />Decision</li>
        <li><span className="gr-mark gr-mark--person" />Person</li>
        <li><span className="gr-mark gr-mark--meeting" />Meeting</li>
        <li><span className="gr-mark gr-mark--note" />Note</li>
        <li className="gr-legend__hint">Drag to move, scroll or pinch to zoom, click to open.</li>
      </ul>

      <details className="gr-list">
        <summary>As a list</summary>
        {NODE_TYPES.filter((t) => counts[t]).map((t) => (
          <section key={t} className="gr-list__group">
            <h3 className="gr-list__title">{NODE_LABELS[t]} <span className="db-mono">{counts[t]}</span></h3>
            <ul>
              {shown.nodes.filter((n) => n.type === t).slice(0, 300).map((n) => (
                <li key={n.id}><Link href={n.href}>{n.label}</Link><span className="gr-list__sub">{n.type === "promise" || n.type === "decision" ? kindWord(n) : n.sub ?? ""}</span></li>
              ))}
            </ul>
          </section>
        ))}
      </details>
    </div>
  );
}
