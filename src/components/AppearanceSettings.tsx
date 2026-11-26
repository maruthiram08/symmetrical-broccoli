"use client";

import { useMemo, useRef, useState, type CSSProperties } from "react";
import {
  DEFAULT_ID, DEFAULT_THEME, DENSITIES, FONTS, RADII, exportTheme, normHex, previewVars, themeWarnings,
  type Density, type FontId, type Palette, type Radius, type Theme, type ThemeState,
} from "@/lib/theme/theme";
import { deleteThemeAction, importThemesAction, saveThemeAction, applyThemeAction, type ThemeResult } from "@/app/theme-actions";
import { ModeSwitch } from "./ModeSwitch";
import type { Mode } from "@/lib/theme/mode";

const reload = () => window.location.reload();

/** Settings › Appearance: your themes, an editor with a live light and dark preview, import and export. */
export function AppearanceSettings({ initial, mode = "system" }: { initial: ThemeState; mode?: Mode }) {
  const [state, setState] = useState(initial);
  const [draft, setDraft] = useState<Theme | null>(null);
  const [variant, setVariant] = useState<"light" | "dark">("light");
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const all = [DEFAULT_THEME, ...state.themes];

  async function run(p: Promise<ThemeResult>, after?: (r: Extract<ThemeResult, { ok: true }>) => void) {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const r = await p;
      if (!r.ok) return setError(r.error);
      setState(r.state);
      after?.(r);
    } catch {
      setError("Couldn't save that. Is Daily brief still running?");
    } finally {
      setBusy(false);
    }
  }

  const startNew = (from: Theme) => {
    setDraft({ ...structuredClone(from), id: "", name: from.id === DEFAULT_ID ? "My theme" : `${from.name} copy` });
    setVariant("light");
  };
  const set = (patch: Partial<Theme>) => setDraft((d) => (d ? { ...d, ...patch } : d));
  const setColor = (k: keyof Palette, v: string) => setDraft((d) => (d ? { ...d, [variant]: { ...d[variant], [k]: v } } : d));

  function download(t: Theme) {
    const url = URL.createObjectURL(new Blob([exportTheme(t)], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${t.name.replace(/[^\p{L}\p{N}]+/gu, "-").toLowerCase() || "theme"}.theme.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }

  async function copy(t: Theme) {
    try {
      await navigator.clipboard.writeText(exportTheme(t));
      setNote(`Copied “${t.name}” as JSON.`);
    } catch {
      setError("Couldn't copy. Use Export instead.");
    }
  }

  async function onImport(f: File | undefined) {
    if (!f) return;
    const text = await f.text();
    if (file.current) file.current.value = "";
    await run(importThemesAction(text), (r) => setNote(`Imported ${r.count} theme${r.count === 1 ? "" : "s"}.`));
  }

  return (
    <section className="db-stack db-subsection th" id="appearance" aria-labelledby="appearance-title">
      <h2 className="db-section__title" id="appearance-title">Appearance</h2>
      <ModeSwitch initial={mode} />
      <p className="db-field__hint">Themes change colours, type, spacing and corners. Each has a light and a dark version, used by the mode above.</p>

      <ul className="th-list" aria-label="Themes">
        {all.map((t) => {
          const on = (state.active || DEFAULT_ID) === t.id || (t.id === DEFAULT_ID && !state.themes.some((x) => x.id === state.active));
          return (
            <li key={t.id} className="th-row" data-on={on ? "" : undefined}>
              <span className="th-swatch" aria-hidden="true">
                <i style={{ background: t.light.bg, borderColor: t.light.ink }} />
                <i style={{ background: t.light.accent }} />
                <i style={{ background: t.dark.bg, borderColor: t.dark.ink }} />
              </span>
              <span className="th-row__name">{t.name}{t.id === DEFAULT_ID ? <span className="th-row__tag">default</span> : null}</span>
              {on ? <span className="th-row__on">In use</span> : (
                <button className="db-act" type="button" disabled={busy} onClick={() => run(applyThemeAction(t.id), reload)}>Use</button>
              )}
              {t.id === DEFAULT_ID ? (
                <button className="db-act" type="button" onClick={() => startNew(t)}>Duplicate</button>
              ) : (
                <>
                  <button className="db-act" type="button" onClick={() => { setDraft(structuredClone(t)); setVariant("light"); }}>Edit</button>
                  <button className="db-act" type="button" onClick={() => download(t)}>Export</button>
                  <button className="db-act" type="button" onClick={() => copy(t)}>Copy</button>
                  <button className="db-act db-act--danger" type="button" disabled={busy} onClick={() => { if (confirm(`Delete “${t.name}”?`)) run(deleteThemeAction(t.id), on ? reload : undefined); }}>Delete</button>
                </>
              )}
            </li>
          );
        })}
      </ul>

      <div className="db-row">
        <button className="db-btn" type="button" onClick={() => startNew(all.find((t) => t.id === state.active) ?? DEFAULT_THEME)}>New theme</button>
        <label className="db-btn db-btn--ghost th-import">
          Import JSON
          <input ref={file} type="file" accept="application/json,.json" onChange={(e) => onImport(e.target.files?.[0])} />
        </label>
      </div>
      {error ? <p className="db-note db-note--error" role="alert">{error}</p> : null}
      {note ? <p className="db-note" role="status">{note}</p> : null}

      {draft ? (
        <ThemeEditor
          draft={draft}
          variant={variant}
          busy={busy}
          onVariant={setVariant}
          onChange={set}
          onColor={setColor}
          onCancel={() => setDraft(null)}
          onSave={(activate) => run(saveThemeAction(draft, activate), (r) => { setDraft(null); if (activate) reload(); else setNote(`Saved “${draft.name}”.`); void r; })}
        />
      ) : null}
    </section>
  );
}

function ThemeEditor({ draft, variant, busy, onVariant, onChange, onColor, onCancel, onSave }: {
  draft: Theme; variant: "light" | "dark"; busy: boolean;
  onVariant: (v: "light" | "dark") => void; onChange: (p: Partial<Theme>) => void; onColor: (k: keyof Palette, v: string) => void;
  onCancel: () => void; onSave: (activate: boolean) => void;
}) {
  const warnings = useMemo(() => themeWarnings(draft), [draft]);
  const p = draft[variant];
  return (
    <div className="th-ed" aria-label="Theme editor">
      <div className="db-field">
        <label className="db-field__label" htmlFor="th-name">Name</label>
        <input className="db-input" id="th-name" value={draft.name} maxLength={40} onChange={(e) => onChange({ name: e.target.value })} />
      </div>

      <div className="th-seg" role="tablist" aria-label="Variant">
        {(["light", "dark"] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={variant === v} className="th-seg__one" onClick={() => onVariant(v)}>{v === "light" ? "Light" : "Dark"}</button>
        ))}
      </div>
      <div className="th-colors">
        {([["accent", "Accent", "You owe, the brand mark, switches"], ["bg", "Background", ""], ["ink", "Ink", "Text and lines"]] as const).map(([k, label, hint]) => (
          <ColorField key={`${variant}-${k}`} id={`th-${variant}-${k}`} label={label} hint={hint} value={p[k]} onChange={(v) => onColor(k, v)} />
        ))}
      </div>

      <div className="db-field">
        <label className="db-field__label" htmlFor="th-font">Font</label>
        <select className="db-input" id="th-font" value={draft.font} onChange={(e) => onChange({ font: e.target.value as FontId })}>
          {Object.entries(FONTS).map(([id, f]) => <option key={id} value={id}>{f.label}</option>)}
        </select>
      </div>
      <Segmented label="Density" value={draft.density} options={DENSITIES} onChange={(v) => onChange({ density: v as Density })} />
      <Segmented label="Corners" value={draft.radius} options={RADII} onChange={(v) => onChange({ radius: v as Radius })} />

      <div className="th-previews">
        <Preview theme={draft} dark={false} />
        <Preview theme={draft} dark />
      </div>
      {warnings.map((w) => <p key={w} className="db-note db-note--error">{w}</p>)}

      <div className="db-row">
        <button className="db-btn db-btn--primary" type="button" disabled={busy || !draft.name.trim()} onClick={() => onSave(true)}>Save and use</button>
        <button className="db-btn" type="button" disabled={busy || !draft.name.trim()} onClick={() => onSave(false)}>Save</button>
        <button className="db-btn db-btn--ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function ColorField({ id, label, hint, value, onChange }: { id: string; label: string; hint: string; value: string; onChange: (v: string) => void }) {
  const [text, setText] = useState(value);
  return (
    <div className="db-field th-color">
      <label className="db-field__label" htmlFor={id}>{label}</label>
      <span className="th-color__row">
        <input type="color" aria-label={`${label} colour`} value={normHex(value) ?? "#000000"} onChange={(e) => { setText(e.target.value); onChange(e.target.value); }} />
        <input className="db-input db-mono" id={id} value={text} spellCheck={false} maxLength={7}
          onChange={(e) => { setText(e.target.value); const h = normHex(e.target.value); if (h) onChange(h); }}
          onBlur={() => setText(normHex(text) ?? value)} />
      </span>
      {hint ? <span className="db-field__hint">{hint}</span> : null}
    </div>
  );
}

function Segmented({ label, value, options, onChange }: { label: string; value: string; options: Record<string, { label: string }>; onChange: (v: string) => void }) {
  return (
    <div className="db-field">
      <span className="db-field__label" id={`th-${label}`}>{label}</span>
      <div className="th-seg" role="radiogroup" aria-labelledby={`th-${label}`}>
        {Object.entries(options).map(([id, o]) => (
          <button key={id} type="button" role="radio" aria-checked={value === id} className="th-seg__one" onClick={() => onChange(id)}>{o.label}</button>
        ))}
      </div>
    </div>
  );
}

/** A small Today screen drawn with the app's own classes and the draft's variables. */
function Preview({ theme, dark }: { theme: Theme; dark: boolean }) {
  const style = { ...previewVars(theme, dark), colorScheme: dark ? "dark" : "light" } as CSSProperties;
  return (
    <div className="th-prev" style={style} aria-label={`${dark ? "Dark" : "Light"} preview`}>
      <span className="th-prev__label">{dark ? "Dark" : "Light"}</span>
      <div className="db-side__brand th-prev__brand"><span><i aria-hidden="true" />Daily brief</span></div>
      <div className="db-section__head th-prev__head"><h3 className="db-section__title">You owe</h3><span className="db-section__count">2</span></div>
      <div className="db-item db-item--owe">
        <span className="db-item__icon"><span className="db-mark db-mark--owe" /></span>
        <span className="db-item__text">Send <b>Nitin</b> the deck</span>
        <span className="db-item__side"><span className="db-item__time">Fri</span></span>
        <span className="db-item__meta">Banner review · 25 Nov</span>
      </div>
      <div className="db-item">
        <span className="db-item__icon"><span className="db-mark db-mark--overdue" /></span>
        <span className="db-item__text">Book the venue</span>
        <span className="db-item__side"><span className="db-item__late">2 days late</span></span>
        <span className="db-item__meta">Offsite planning</span>
      </div>
      <div className="th-prev__acts">
        <span className="db-btn db-btn--primary th-prev__btn">Check meetings</span>
        <span className="db-tag"><span className="db-mark db-mark--waiting" />Waiting on</span>
      </div>
    </div>
  );
}
