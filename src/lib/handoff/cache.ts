// In-memory draft cache for the session: one entry per item and target, so reopening a panel or
// switching tabs never calls Claude again. In-flight drafts are shared so a double click costs one call.
import type { Drafts, HandoffTarget } from "./types";

export class DraftCache {
  private done = new Map<string, Drafts>();
  private inflight = new Map<string, Promise<Drafts>>();

  private key(itemId: string, target: HandoffTarget) {
    return `${itemId}:${target}`;
  }

  /** Cached drafts for the item, when every target has one. */
  get(itemId: string): Drafts | null {
    const s = this.done.get(this.key(itemId, "slack"));
    const e = this.done.get(this.key(itemId, "email"));
    const c = this.done.get(this.key(itemId, "claude"));
    if (!s || !e || !c) return null;
    return {
      slack: s.slack, slackSource: s.slackSource,
      emailSubject: e.emailSubject, emailBody: e.emailBody, emailSource: e.emailSource,
      claudePrompt: c.claudePrompt,
    };
  }

  set(itemId: string, d: Drafts): void {
    for (const t of ["slack", "email", "claude"] as const) this.done.set(this.key(itemId, t), d);
  }

  /** Returns the cached drafts, or runs `make` once (sharing concurrent callers) and caches it. */
  async getOrMake(itemId: string, make: () => Promise<Drafts>): Promise<{ drafts: Drafts; cached: boolean }> {
    const hit = this.get(itemId);
    if (hit) return { drafts: hit, cached: true };
    let p = this.inflight.get(itemId);
    const cached = !!p;
    if (!p) {
      p = make().then((d) => { this.set(itemId, d); return d; }).finally(() => this.inflight.delete(itemId));
      this.inflight.set(itemId, p);
    }
    return { drafts: await p, cached };
  }

  clear(): void {
    this.done.clear();
    this.inflight.clear();
  }
}
