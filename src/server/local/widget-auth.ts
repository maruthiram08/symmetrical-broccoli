import { bearer, getPhoneStore, type PhoneStore } from "./phone";
import { REMOTE_HEADER } from "./phone-proxy";

/**
 * Who may read /api/widget:
 * - an iOS Shortcut or widget app with `Authorization: Bearer <token>` (a widget token from Settings, or a paired phone's),
 * - a paired phone in its browser (the phone door checked its cookie and says which device it is),
 * - the Mac app's menu bar (X-Daily-Brief: tray, only from this Mac: the phone door drops that header).
 * A web page can't send either header cross-origin without a CORS preflight, which this route never allows.
 */
export function widgetAllowed(h: Pick<Headers, "get">, phone: PhoneStore = getPhoneStore()): boolean {
  const remote = h.get(REMOTE_HEADER);
  const tok = bearer(h.get("authorization"));
  if (tok) return phone.verify(tok) !== null;
  if (remote) return remote !== "public" && phone.hasDevice(remote);
  return h.get("x-daily-brief") === "tray";
}
