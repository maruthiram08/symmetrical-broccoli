// State for the AI extras (nudges, contradiction flags), kept in its own file next to state.json
// (.daily-brief/ai.json, 0600) so the main store's format doesn't change. Same pattern as FileStore:
// reload when the file changed on disk, write atomically after every change.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dataDir } from "./paths";

export interface Nudge {
  itemId: string;
  text: string;
  source: "ai" | "template";
  createdAt: string;
}

export interface Contradiction {
  id: string;
  /** The new decision. */
  newId: string;
  /** The earlier decision it may change. */
  oldId: string;
  /** "launch moved from Friday to Monday". */
  note: string;
  createdAt: string;
  status: "open" | "kept" | "replaced";
}

export interface AiState {
  version: 1;
  nudges: Nudge[];
  contradictions: Contradiction[];
  /** Decision ids already compared with earlier ones. */
  checked: string[];
  /** False until the first run, which marks every existing decision as checked (no model calls for history). */
  primed: boolean;
  /** Local date of the last daily nudge run. */
  nudgeDay: string | null;
}

export const emptyAiState = (): AiState => ({ version: 1, nudges: [], contradictions: [], checked: [], primed: false, nudgeDay: null });
const MAX_CHECKED = 5000;

export class AiStore {
  protected s: AiState = emptyAiState();
  private mtime = 0;
  constructor(readonly path: string) { this.reload(); }

  protected reload(): void {
    if (!existsSync(this.path)) return;
    const m = statSync(this.path).mtimeMs;
    if (m === this.mtime) return;
    try {
      this.s = { ...emptyAiState(), ...(JSON.parse(readFileSync(this.path, "utf8")) as Partial<AiState>) };
    } catch {
      this.s = emptyAiState(); // a broken file only loses cached drafts and flags
    }
    this.mtime = m;
  }

  protected flush(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    this.s.checked = this.s.checked.slice(-MAX_CHECKED);
    writeFileSync(tmp, JSON.stringify(this.s), { mode: 0o600 });
    renameSync(tmp, this.path);
    chmodSync(this.path, 0o600);
    this.mtime = statSync(this.path).mtimeMs;
  }

  // ---------- nudges ----------
  nudge(itemId: string): Nudge | null { this.reload(); return this.s.nudges.find((n) => n.itemId === itemId) ?? null; }
  nudges(): Nudge[] { this.reload(); return [...this.s.nudges]; }
  saveNudge(n: Nudge): void {
    this.reload();
    this.s.nudges = [...this.s.nudges.filter((x) => x.itemId !== n.itemId), n];
    this.flush();
  }
  /** Drop cached nudges whose item is no longer one to nudge. */
  pruneNudges(keep: Set<string>): void {
    this.reload();
    const next = this.s.nudges.filter((n) => keep.has(n.itemId));
    if (next.length !== this.s.nudges.length) { this.s.nudges = next; this.flush(); }
  }
  nudgeDay(): string | null { this.reload(); return this.s.nudgeDay; }
  setNudgeDay(d: string): void { this.reload(); this.s.nudgeDay = d; this.flush(); }

  // ---------- contradictions ----------
  primed(): boolean { this.reload(); return this.s.primed; }
  /** Mark decisions as compared. `prime` also records that the first run happened. */
  markChecked(ids: string[], prime = false): void {
    this.reload();
    const have = new Set(this.s.checked);
    this.s.checked.push(...ids.filter((i) => !have.has(i)));
    if (prime) this.s.primed = true;
    this.flush();
  }
  checkedSet(): Set<string> { this.reload(); return new Set(this.s.checked); }
  contradictions(): Contradiction[] { this.reload(); return [...this.s.contradictions]; }
  addContradiction(c: Contradiction): void {
    this.reload();
    if (this.s.contradictions.some((x) => x.newId === c.newId && x.oldId === c.oldId)) return;
    this.s.contradictions.push(c);
    this.flush();
  }
  setContradictionStatus(id: string, status: Contradiction["status"]): Contradiction | null {
    this.reload();
    const c = this.s.contradictions.find((x) => x.id === id);
    if (!c) return null;
    c.status = status;
    this.flush();
    return c;
  }
}

const g = globalThis as unknown as { __dbAiStore?: AiStore };
export function getAiStore(): AiStore {
  return (g.__dbAiStore ??= new AiStore(join(dataDir(), "ai.json")));
}
