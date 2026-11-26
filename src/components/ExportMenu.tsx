/**
 * "Export" on a note, a day or Today: PDF (the print dialog, Save as PDF), a self-contained HTML
 * file, a Word file, or a password-protected file. Plain links, no script. They open a new tab:
 * in the Mac app a new tab opens in your browser, which saves files and prints reliably.
 */
export function ExportMenu({ type, id, label = "Export" }: { type: "note" | "day"; id: string; label?: string }) {
  const base = `/api/export/${type}/${encodeURIComponent(id)}`;
  return (
    <details className="ex-menu">
      <summary className="db-act ex-menu__btn">{label}</summary>
      <div className="ex-menu__pop" role="menu">
        <a role="menuitem" className="ex-menu__one" href={`${base}?format=print`} target="_blank" rel="noopener">PDF<span>Print, then Save as PDF</span></a>
        <a role="menuitem" className="ex-menu__one" href={`${base}?format=html`} target="_blank" rel="noopener" download>HTML<span>One file, opens anywhere</span></a>
        <a role="menuitem" className="ex-menu__one" href={`${base}?format=docx`} target="_blank" rel="noopener" download>Word<span>.docx</span></a>
        <a role="menuitem" className="ex-menu__one" href={`/export/protect/${type}/${encodeURIComponent(id)}`} target="_blank" rel="noopener">Share as protected file<span>Encrypted HTML, opens with a password</span></a>
      </div>
    </details>
  );
}
