// Local public API, docs/API.md. GET one item, PATCH its status, star, snooze, due (and text on your own).
import { getItemRoute, patchItemRoute, preflight } from "@/server/integrations/api";
import { liveDeps } from "@/server/integrations/runtime";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export const GET = async (req: Request, { params }: Ctx) => getItemRoute(req, liveDeps(), { id: decodeURIComponent((await params).id) });
export const PATCH = async (req: Request, { params }: Ctx) => patchItemRoute(req, liveDeps(), { id: decodeURIComponent((await params).id) });
export const OPTIONS = (req: Request) => preflight(req, liveDeps());
