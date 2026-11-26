import { swSource } from "@/lib/platform/sw";

export const dynamic = "force-static";

/** The service worker (see src/lib/platform/sw.ts). A new build gets new cache names. */
export function GET() {
  const version = `${process.env.DAILY_BRIEF_VERSION ?? "0"}-${process.env.DAILY_BRIEF_COMMIT || "dev"}`;
  return new Response(swSource(version), {
    headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" },
  });
}
