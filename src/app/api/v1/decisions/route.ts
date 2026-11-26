// Local public API, docs/API.md.
import { listDecisionsRoute, preflight } from "@/server/integrations/api";
import { liveDeps } from "@/server/integrations/runtime";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => listDecisionsRoute(req, liveDeps());
export const OPTIONS = (req: Request) => preflight(req, liveDeps());
