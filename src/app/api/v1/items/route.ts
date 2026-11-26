// Local public API, docs/API.md. GET lists items, POST adds one of your own.
import { createItemRoute, listItemsRoute, preflight } from "@/server/integrations/api";
import { liveDeps } from "@/server/integrations/runtime";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => listItemsRoute(req, liveDeps());
export const POST = (req: Request) => createItemRoute(req, liveDeps());
export const OPTIONS = (req: Request) => preflight(req, liveDeps());
