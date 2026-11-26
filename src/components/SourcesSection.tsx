import { Button } from "@/components/Button";
import { SubmitOnChange } from "@/components/SubmitOnChange";
import type { SourceStatus } from "@/server/recorders/status";
import { saveSourcePath, saveSourceToggle, uploadTranscript } from "@/app/source-actions";

const COPY: Record<SourceStatus["key"], { label: string; hint: string; noun: string; missing: string }> = {
  granola: {
    label: "Granola",
    hint: "Reads meetings and transcripts from Granola's cache on this Mac. Nothing is sent to Granola.",
    noun: "meeting",
    missing: "Granola's cache isn't on this Mac.",
  },
  zoom: {
    label: "Zoom recordings",
    hint: "Reads transcripts (.vtt) and saved captions from your local Zoom recordings folder.",
    noun: "recording",
    missing: "No Zoom recordings folder here yet.",
  },
  files: {
    label: "Google Meet and transcript files",
    hint: "Drop a transcript in the inbox folder, or upload it below: a Google Meet transcript downloaded from Docs (.docx or .txt), or any .vtt, .srt, .txt or .md.",
    noun: "file",
    missing: "The inbox folder is made when you turn this on.",
  },
  phone: {
    label: "Phone calls",
    hint: "Call transcripts in the same inbox (from iOS Notes or Just Press Record, as .txt). Put them in inbox/phone/, or name them like “Call with Ravi”.",
    noun: "call",
    missing: "The inbox folder is made when you turn this on.",
  },
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function statusLine(s: SourceStatus): string {
  const c = COPY[s.key];
  if (s.error) return `Found, but ${s.error}.`;
  if (!s.present || s.found === null) return c.missing;
  const parts = [`Found ${plural(s.found, c.noun)}`];
  if (s.sinceCount !== null && s.since && s.sinceCount !== s.found) {
    parts.push(s.enabled ? `${s.sinceCount} since you turned it on` : `turning it on reads the ${s.sinceCount} from the last 7 days`);
  }
  if (s.imported || s.duplicates) parts.push(`${s.imported} brought in${s.duplicates ? `, ${s.duplicates} already here from another recorder` : ""}`);
  return parts.join(" · ");
}

/** Settings > Other recorders: Granola, Zoom, the transcript inbox and phone calls. All off by default. */
export function SourcesSection({ statuses, flash }: { statuses: SourceStatus[]; flash: { upload?: string; source?: string; which?: string } }) {
  const inbox = statuses.find((s) => s.key === "files");
  const inboxOn = statuses.some((s) => (s.key === "files" || s.key === "phone") && s.enabled);
  return (
    <section id="sources" className="db-stack db-subsection" aria-labelledby="sources-title">
      <h2 className="db-section__title" id="sources-title">Other recorders</h2>
      <p className="db-note db-sources__lead">
        Besides Wispr Flow, Daily brief can read meetings recorded elsewhere. Everything is read on this Mac; each is off
        until you turn it on. A meeting two of them recorded is read once.
      </p>
      <ul className="db-sources">
        {statuses.map((s) => {
          const c = COPY[s.key];
          const sharedFolder = s.key === "phone";
          return (
            <li key={s.key} className="db-source" data-on={s.enabled ? "" : undefined}>
              <form action={saveSourceToggle} className="db-source__head">
                <input type="hidden" name="source" value={s.key} />
                <label className="db-check">
                  <SubmitOnChange name="enabled" defaultChecked={s.enabled} />
                  <span>
                    <span className="db-check__label">{c.label}</span>
                    <span className="db-field__hint">{c.hint}</span>
                  </span>
                </label>
                <noscript><Button type="submit" variant="secondary">Save</Button></noscript>
              </form>
              <p className="db-source__status" aria-live="polite">
                <span className="db-source__dot" data-state={s.error ? "error" : s.present ? "found" : "missing"} aria-hidden="true" />
                {statusLine(s)}
              </p>
              {sharedFolder ? (
                <p className="db-source__path db-mono">Same inbox: {inbox?.path ?? s.path}</p>
              ) : (
                <details className="db-source__folder" open={flash.source === "badpath" && flash.which === s.key ? true : undefined}>
                  <summary>
                    <span className="db-mono">{s.path}</span>
                    <span className="db-source__change">Change</span>
                  </summary>
                  <form action={saveSourcePath} className="db-row db-source__pathform">
                    <input type="hidden" name="source" value={s.key} />
                    <input className="db-input db-mono" name="path" defaultValue={s.path} aria-label={`${c.label} folder`} placeholder="Default" />
                    <Button type="submit" variant="secondary">Save</Button>
                  </form>
                  {flash.source === "badpath" && flash.which === s.key ? (
                    <p className="db-note db-note--error" role="alert">Use a full path, like ~/Documents/Zoom.</p>
                  ) : null}
                </details>
              )}
            </li>
          );
        })}
      </ul>
      <form action={uploadTranscript} className="db-offer db-source__upload">
        <p className="db-check__label">Import a transcript</p>
        <p className="db-field__hint" style={{ margin: 0 }}>
          A Google Meet transcript (in Docs: File, Download, Microsoft Word), or any .vtt, .srt, .txt or .md. It is saved to the
          inbox{inboxOn ? "" : ", which turns on"} and read in a minute. Each meeting is one AI read, about ₹3.50.
        </p>
        <div className="db-row">
          <input className="db-source__file" type="file" name="file" accept=".docx,.txt,.vtt,.srt,.md" required aria-label="Transcript file" />
          <select className="db-input db-source__kind" name="kind" aria-label="What it is" defaultValue="meeting">
            <option value="meeting">Meeting</option>
            <option value="phone">Phone call</option>
          </select>
          <Button type="submit" variant="secondary">Import</Button>
        </div>
        {flash.upload === "ok" ? <p className="db-note" role="status" style={{ margin: 0 }}>Saved to the inbox. It shows up on Today once it&apos;s read.</p> : null}
        {flash.upload && flash.upload !== "ok" ? (
          <p className="db-note db-note--error" role="alert" style={{ margin: 0 }}>
            {flash.upload === "type" ? "That file type can't be read. Use .docx, .txt, .vtt, .srt or .md." : flash.upload === "size" ? "That file is too big (10 MB at most)." : flash.upload === "empty" ? "Pick a file first." : "Couldn't save that file. Try again."}
          </p>
        ) : null}
      </form>
    </section>
  );
}
