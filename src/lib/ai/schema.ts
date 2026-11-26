// JSON-schema shapes the other providers accept for the same output schema.

type Json = Record<string, unknown>;

/**
 * OpenAI-style strict schema: every property is required and objects allow nothing extra, so a
 * property that was optional becomes nullable instead. The zod schema already reads null as "left
 * out", so the parsed output is the same.
 */
export function strictSchema(schema: Json): Json {
  const walk = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(walk);
    if (!s || typeof s !== "object") return s;
    const o = { ...(s as Json) };
    if (o.type === "object" && o.properties && typeof o.properties === "object") {
      const props = o.properties as Record<string, Json>;
      const required = new Set((o.required as string[] | undefined) ?? []);
      const next: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        let p = walk(v) as Json;
        if (!required.has(k)) p = nullable(p);
        next[k] = p;
      }
      o.properties = next;
      o.required = Object.keys(props);
      o.additionalProperties = false;
    }
    if (o.items) o.items = walk(o.items);
    return o;
  };
  return walk(schema) as Json;
}

function nullable(p: Json): Json {
  const t = p.type;
  const out: Json = { ...p };
  if (Array.isArray(t)) out.type = t.includes("null") ? t : [...t, "null"];
  else if (typeof t === "string") out.type = t === "null" ? t : [t, "null"];
  if (Array.isArray(p.enum) && !p.enum.includes(null)) out.enum = [...p.enum, null];
  return out;
}

/** Without additionalProperties anywhere (for APIs that reject the keyword). */
export function withoutAdditional(schema: Json): Json {
  const walk = (s: unknown): unknown => {
    if (Array.isArray(s)) return s.map(walk);
    if (!s || typeof s !== "object") return s;
    const o: Json = {};
    for (const [k, v] of Object.entries(s as Json)) if (k !== "additionalProperties") o[k] = walk(v);
    return o;
  };
  return walk(schema) as Json;
}

/** Parses a JSON object from model text, tolerating a ```json fence around it. Null when it isn't one. */
export function parseJsonObject(text: string): Json | null {
  const t = text.trim().replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  if (!t.startsWith("{")) return null;
  try {
    const v = JSON.parse(t) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
  } catch {
    return null;
  }
}
