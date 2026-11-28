// Test doubles for the jobs. Not imported by production code.
import type { BriefModel, Connection, ExtractionInput, ExtractionResult, User } from "@/lib/types";
import { MemoryStore } from "@/server/store";
import type { Deps } from "@/server/jobs/types";
import type { WisprClient, WisprMeeting } from "@/server/wispr/client";

export class FakeWispr {
  meetings = new Map<string, WisprMeeting[]>();
  transcripts = new Map<string, string>();
  failingUsers = new Set<string>();
  sinceCalls: Array<{ userId: string; since: string; includeShared?: boolean }> = [];
  transcriptCalls: string[] = [];

  client = (userId: string): WisprClient => ({
    listMeetingsSince: async (since, opts) => {
      this.sinceCalls.push({ userId, since, ...(opts?.includeShared ? { includeShared: true } : {}) });
      if (this.failingUsers.has(userId)) throw new Error("wispr down");
      return (this.meetings.get(userId) ?? []).filter((m) => m.startedAt >= since && (!m.shared || opts?.includeShared));
    },
    getTranscript: async (id) => {
      this.transcriptCalls.push(id);
      if (this.failingUsers.has(userId)) throw new Error("wispr down");
      return this.transcripts.get(id) ?? "";
    },
  });
}

export function meeting(id: string, startedAt: string, extra: Partial<WisprMeeting> = {}): WisprMeeting {
  return { providerMeetingId: id, title: `Meeting ${id}`, startedAt, participants: ["Nitin"], finalized: true, hasTranscript: true, ...extra };
}

export function connect(store: MemoryStore, userId: string, extra: Partial<Connection> = {}): Connection {
  const c: Connection = {
    userId, provider: "wispr_flow", accessToken: "at", refreshToken: "rt",
    expiresAt: "2099-01-01T00:00:00.000Z", lastSeenAt: null, status: "active", ...extra,
  };
  store.connections.set(userId, c);
  return c;
}

export function emptyBrief(user: User, date: string): BriefModel {
  return {
    userId: user.id, date, dateLabel: date, meetingCount: 0,
    wrap: { meetings: 0, made: 0, kept: 0, late: 0 },
    youOwe: [], waitingOn: [], decisions: [], closedToday: [], stillOpenCount: 0, stillOpen: [],
    empty: "no_meetings", subject: "Your brief",
  };
}

export function fakeDeps(over: Partial<Omit<Deps, "wispr" | "now">> & { store: MemoryStore; wispr: FakeWispr; now: Date }) {
  const sent: Array<{ to: string; model: BriefModel; markdown: string }> = [];
  const extractCalls: ExtractionInput[] = [];
  let clock = over.now;
  const rest: Partial<Record<keyof Deps, unknown>> = { ...over };
  delete rest.wispr;
  delete rest.now;
  const deps: Deps = {
    model: "test-model",
    extract: async (input): Promise<ExtractionResult> => {
      extractCalls.push(input);
      return {
        newItems: [{ kind: "owe", text: "Send Nitin the banner text", person: "Nitin", quote: "I'll send it", dueAt: null }],
        closes: [],
        usage: { inputTokens: 1000, outputTokens: 200 },
      };
    },
    costInr: (_m, u) => (u.inputTokens + u.outputTokens) / 1000,
    buildBrief: async (_s, user, now) => emptyBrief(user, now.toISOString().slice(0, 10)),
    renderMarkdown: (m) => `# Brief ${m.date}`,
    publish: async (user, model, markdown) => {
      sent.push({ to: user.email, model, markdown });
      return { id: `brief-${sent.length}` };
    },
    ...(rest as Partial<Deps>),
    store: over.store,
    wispr: over.wispr.client,
    now: () => clock,
  };
  return {
    deps,
    sent,
    extractCalls,
    setNow: (d: Date) => { clock = d; },
  };
}
