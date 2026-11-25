import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";

/** Vercel Cron sends "Authorization: Bearer $CRON_SECRET". */
export function isCronAuthorized(req: Request, secret: string = env.cronSecret): boolean {
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
