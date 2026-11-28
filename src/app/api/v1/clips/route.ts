// Local public API, docs/API.md: the web clipper saves to the Inbox note or a new note.
import { preflight } from "@/server/integrations/api";
import { createClipRoute } from "@/server/integrations/clips";
import { liveDeps } from "@/server/integrations/runtime";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => createClipRoute(req, liveDeps());
export const OPTIONS = (req: Request) => preflight(req, liveDeps());
