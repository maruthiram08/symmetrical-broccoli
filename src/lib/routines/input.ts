// What the routine editor and quick capture send: checked here, so actions and tests share one rule set.
import { z } from "zod";
import type { Cadence, Weekday } from "./types";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const CadenceSchema: z.ZodType<Cadence> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily") }),
  z.object({ kind: z.literal("weekdays") }),
  z.object({ kind: z.literal("weekly"), days: z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one day.").max(7).transform((d) => [...new Set(d)].sort() as Weekday[]) }),
  z.object({ kind: z.literal("monthly"), day: z.number().int().min(1, "Pick a day from 1 to 31.").max(31, "Pick a day from 1 to 31.") }),
  z.object({ kind: z.literal("every"), n: z.number().int().min(2, "Every 2 days or more.").max(365), from: z.string().regex(DATE) }),
]) as unknown as z.ZodType<Cadence>;

export const RoutineInputSchema = z.object({
  title: z.string().trim().min(1, "Say what it is.").max(200),
  cadence: CadenceSchema,
  time: z.preprocess((v) => v || null, z.string().regex(TIME, "Use a time like 10:00.").nullable()),
  person: z.preprocess((v) => (typeof v === "string" ? v.trim() : v) || null, z.string().max(80).nullable()),
});

export type RoutineInput = z.input<typeof RoutineInputSchema>;
export type RoutineFields = z.output<typeof RoutineInputSchema>;

export function checkRoutineInput(input: unknown): { ok: true; value: RoutineFields } | { ok: false; error: string } {
  const p = RoutineInputSchema.safeParse(input);
  return p.success ? { ok: true, value: p.data } : { ok: false, error: p.error.issues[0]?.message ?? "Check the fields." };
}
