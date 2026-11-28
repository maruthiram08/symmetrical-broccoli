// WhatsApp Cloud API template message. Outside a 24-hour customer-service window a business may only
// send approved templates, so the brief goes as one: {{1}} the title, {{2}} the summary, {{3}} the link.
import type { Digest } from "./digest";

/** Template parameters can't hold newlines, tabs or more than four spaces in a row. */
export function waParam(s: string, max = 900): string {
  const clean = s.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim();
  return (clean.length > max ? `${clean.slice(0, max - 1)}…` : clean) || "-";
}

export function whatsappTemplate(d: Digest, cfg: { to: string; template: string; language: string; link: string }): Record<string, unknown> {
  return {
    messaging_product: "whatsapp",
    to: cfg.to.replace(/[^\d]/g, ""),
    type: "template",
    template: {
      name: cfg.template,
      language: { code: cfg.language || "en" },
      components: [
        {
          type: "body",
          parameters: [d.title, d.summary, cfg.link || "Open Daily brief on your Mac"].map((t) => ({ type: "text", text: waParam(t) })),
        },
      ],
    },
  };
}
