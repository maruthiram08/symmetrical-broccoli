import { themeCss } from "@/lib/theme/theme";
import { isHosted } from "@/server/mode";
import { currentTheme } from "@/server/local/themes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The active theme as CSS variables (Settings › Appearance). Empty for the default theme. */
export async function GET() {
  let css = "";
  try {
    if (!isHosted()) css = themeCss(currentTheme());
  } catch {
    css = "";
  }
  return new Response(css, { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
