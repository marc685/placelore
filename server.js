// Placelore server: serves the app, streams answers for "Ask about this place", plans days out,
// and relays OpenStreetMap (Overpass) and Wikidata queries with retries and a cache,
// because those public servers often reject or time out busy browsers.
import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const MODEL = "claude-opus-5-5";
const LIMITS = { bodyBytes: 200_000, messages: 20, messageChars: 4000, contextChars: 60_000, perIpPer10Min: 30 };

const SYSTEM = `You are the Placelore guide, a friendly local expert for travellers in a place they are visiting.

Answer from the place data you are given below. It comes from Wikipedia, Wikidata, OpenStreetMap, iNaturalist, Open-Meteo and Macrostrat and was loaded in the traveller's app. You may add widely known general knowledge about the region, but say so when you go beyond the data, and say plainly when the data doesn't cover something.

Some of the place data may come from Afrikaans Wikipedia. Use it like the rest, and answer in the language the traveller writes in, translating as you go; quote an Afrikaans name or phrase only when it helps, with its meaning.

Keep answers short and practical: a few sentences, or a short list when listing places. Write for a phone screen. Use plain text with simple "- " bullets; no tables or headings.

Never invent phone numbers, prices, opening hours, availability, or business registration status. When someone needs those, point them to a search instead, using these links where they fit:
- Google Maps: https://www.google.com/maps/search/<what>+near+<place>
- Booking.com: https://www.booking.com/searchresults.html?ss=<place>
- Yellow Pages South Africa: https://www.yellowpages.co.za/
- CIPC BizPortal (South African company registration): https://www.bizportal.gov.za/

Do not reproduce passages from copyrighted books, such as T.V. Bulpin's Discovering Southern Africa. You may mention a book and suggest the reader look it up.

For emergencies, give the emergency numbers from the place data first, and tell the traveller to call them.`;

let client = null;
async function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic();
  }
  return client;
}

const hits = new Map(); // ip -> timestamps of recent requests
function rateLimited(ip) {
  const now = Date.now(), recent = (hits.get(ip) || []).filter(t => now - t < 600_000);
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > LIMITS.perIpPer10Min;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > LIMITS.bodyBytes) { reject(new Error("too_large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cleanMessages(raw) {
  if (!Array.isArray(raw)) return null;
  const msgs = raw.slice(-LIMITS.messages)
    .filter(m => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, LIMITS.messageChars) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs.length && msgs[msgs.length - 1].role === "user" ? msgs : null;
}

async function chat(req, res) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const fail = (code, msg) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: msg })); };
  if (rateLimited(ip)) return fail(429, "You're asking quickly. Wait a few minutes and try again.");
  const anthropic = await getClient();
  if (!anthropic) {
    // Names only, never values, so a misnamed setting is easy to spot
    const similar = Object.keys(process.env).filter(k => /anthropic|api_?key|claude/i.test(k));
    return fail(503, "The assistant isn't set up yet: the server has no ANTHROPIC_API_KEY setting." +
      (similar.length ? ` It did find: ${similar.join(", ")}. Rename that to ANTHROPIC_API_KEY.` : " No similar setting was found either."));
  }

  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return fail(400, "The question couldn't be read. Try again."); }
  const messages = cleanMessages(body.messages);
  if (!messages) return fail(400, "Type a question first.");
  const place = String(body.place || "this place").slice(0, 200);
  const context = String(body.context || "").slice(0, LIMITS.contextChars);

  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache", "X-Accel-Buffering": "no" });
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  try {
    const stream = anthropic.beta.messages.stream({
      model: MODEL,
      max_tokens: 4000,
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: [
        { type: "text", text: SYSTEM },
        // The place data stays the same for every question about one place, so it is cached
        { type: "text", text: `Place: ${place}\n\nPlace data loaded in the app:\n${context}`, cache_control: { type: "ephemeral" } }
      ],
      messages
    }, { signal: controller.signal });
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") res.write(event.delta.text);
    }
    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") res.write("\n\nSorry, I can't help with that one. Try asking another way.");
    else if (final.stop_reason === "max_tokens") res.write("\n\n(Answer cut short. Ask me to continue.)");
    res.end();
  } catch (err) {
    if (controller.signal.aborted) return;
    console.error("chat error", err?.status, err?.message);
    const busy = err?.status === 429 || err?.status === 529 || err?.status >= 500;
    res.end(busy ? "\n\nThe assistant is busy right now. Try again in a minute." : "\n\nSomething went wrong answering that. Try again.");
  }
}



/* ---------- Plan a day ---------- */
const PLAN_SYSTEM = `You plan a day out for travellers in a place they are visiting, using the Placelore app's data.

Build the day from the candidate places listed in the request. Every stop at a specific place must be one of the candidates: copy its id exactly into place_id and its name into place_name. For stops that aren't at a listed place (setting off, a drive, back at your stay), leave place_id empty.

Make a day that works on the ground:
- Order stops to avoid backtracking, using the distances given. On foot, keep consecutive stops close (about 3 km at most) and the total walking sensible for the group.
- Fit the day between the start time and sunset, with time to travel between stops. Include lunch: a restaurant or café, or a picnic site, farm stall or wine estate.
- Match the chosen interests, pace and group. With children, choose shorter walks and add something for kids where possible.
- If rain is likely or it's very hot, favour shade, indoor and shorter outdoor options, and say why.
- Never state opening hours, prices or booking rules. Where they matter (wine tastings, restaurants, guided farm visits), say "check opening times" or "book ahead" in the tip.

Use 4 to 7 stops, times as 24-hour "HH:MM". Write plainly and briefly; tips are one practical sentence. Notes hold 1 to 3 short practical reminders for the whole day (water, sun, permits, fuel).`;

const PLAN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["title", "summary", "stops", "notes"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    stops: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["time", "title", "place_id", "place_name", "activity", "tip", "duration_minutes"],
      properties: { time: { type: "string" }, title: { type: "string" }, place_id: { type: "string" }, place_name: { type: "string" },
        activity: { type: "string" }, tip: { type: "string" }, duration_minutes: { type: "integer" } } } },
    notes: { type: "array", items: { type: "string" } }
  }
};

async function plan(req, res) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (rateLimited(ip)) return send(429, { error: "You're asking quickly. Wait a few minutes and try again." });
  const anthropic = await getClient();
  if (!anthropic) return send(503, { error: "Planning isn't set up yet: the server has no ANTHROPIC_API_KEY setting." });
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return send(400, { error: "The request couldn't be read. Try again." }); }
  const candidates = String(body.candidates || "").slice(0, 40_000);
  if (!candidates.trim()) return send(400, { error: "There are no places loaded yet to plan with. Wait for the page to finish loading." });
  const ids = new Set(candidates.split("\n").map(l => l.split(" | ")[0].trim()).filter(Boolean));
  const request = [
    `Place: ${String(body.place || "").slice(0, 200)}`,
    `About the place: ${String(body.about || "").slice(0, 2000)}`,
    `Day: ${String(body.today || "").slice(0, 600)}`,
    `Who and how: ${String(body.prefs || "").slice(0, 600)}`,
    `Candidate places (id | kind | name | distance from the centre | details):\n${candidates}`
  ].join("\n\n");
  try {
    const msg = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      output_config: { effort: "medium", format: { type: "json_schema", schema: PLAN_SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: PLAN_SYSTEM,
      messages: [{ role: "user", content: request }]
    });
    if (msg.stop_reason === "refusal") return send(422, { error: "A plan couldn't be made for this place. Try different interests." });
    const text = msg.content.filter(b => b.type === "text").map(b => b.text).join("");
    const out = JSON.parse(text);
    for (const st of out.stops || []) if (st.place_id && !ids.has(st.place_id)) st.place_id = ""; // only ids we sent
    send(200, out);
  } catch (err) {
    console.error("plan error", err?.status, err?.message);
    const busy = err?.status === 429 || err?.status === 529 || err?.status >= 500;
    send(busy ? 503 : 500, { error: busy ? "The planner is busy right now. Try again in a minute." : "Something went wrong making the plan. Try again." });
  }
}

/* ---------- Overpass and Wikidata relay ---------- */
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
const UA = "Placelore/1.0 (https://github.com/marc685/placelore)";
const cache = new Map(); // key -> { at, body }
const CACHE_MS = 6 * 3600_000, CACHE_MAX = 300;
function cached(key) { const hit = cache.get(key); if (hit && Date.now() - hit.at < CACHE_MS) return hit.body; cache.delete(key); }
function remember(key, body) { cache.set(key, { at: Date.now(), body }); if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function tryFetch(url, init, ms) {
  const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { ...init, signal: c.signal });
    const text = await r.text();
    if (!r.ok) throw Object.assign(new Error(`${r.status}`), { status: r.status });
    JSON.parse(text); // Overpass sometimes answers 200 with an HTML error page
    return text;
  } finally { clearTimeout(t); }
}
const relayHits = new Map();
function relayLimited(ip) {
  const now = Date.now(), recent = (relayHits.get(ip) || []).filter(t => now - t < 600_000);
  recent.push(now); relayHits.set(ip, recent); if (relayHits.size > 5000) relayHits.clear();
  return recent.length > 120;
}
async function relay(req, res, kind) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const send = (code, body) => { res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": code === 200 ? "public, max-age=3600" : "no-store" }); res.end(body); };
  if (relayLimited(ip)) return send(429, JSON.stringify({ error: "too many requests" }));
  let key, attempts;
  if (kind === "overpass") {
    if (req.method !== "POST") return send(405, "{}");
    const body = await readBody(req);
    if (body.length > 20_000 || !body.startsWith("data=")) return send(400, JSON.stringify({ error: "bad query" }));
    key = "o:" + body;
    const init = { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA } };
    attempts = OVERPASS.map(u => () => tryFetch(u, init, 60_000));
  } else {
    const q = new URL(req.url, "http://x").searchParams.get("query") || "";
    if (!q || q.length > 8000) return send(400, JSON.stringify({ error: "bad query" }));
    key = "w:" + q;
    const url = "https://query.wikidata.org/sparql?" + new URLSearchParams({ format: "json", query: q });
    const init = { headers: { Accept: "application/sparql-results+json", "User-Agent": UA } };
    attempts = [() => tryFetch(url, init, 65_000)]; // Wikidata's own limit is 60 s; the browser falls back to a quicker query
  }
  const hit = cached(key); if (hit) return send(200, hit);
  let last;
  for (let round = 0; round < (kind === "overpass" ? 2 : 1); round++) {
    if (round) await sleep(4000);
    for (const attempt of attempts) {
      try { const body = await attempt(); remember(key, body); return send(200, body); }
      catch (e) { last = e; }
    }
  }
  console.error(`${kind} relay failed`, last?.status || last?.name || last?.message);
  send(502, JSON.stringify({ error: last?.name === "AbortError" ? "timeout" : "upstream " + (last?.status || "error") }));
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml" };
async function serveStatic(req, res) {
  const url = new URL(req.url, "http://x");
  let file = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
  if (file === "/" || !path.extname(file)) file = "/index.html";
  try {
    const data = await readFile(path.join(here, "public", file));
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found");
  }
}

http.createServer((req, res) => {
  if (req.url.startsWith("/api/chat")) {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    return chat(req, res).catch(err => { console.error(err); if (!res.headersSent) res.writeHead(500); res.end(); });
  }
  if (req.url.startsWith("/api/plan")) {
    if (req.method !== "POST") { res.writeHead(405); return res.end(); }
    return plan(req, res).catch(err => { console.error(err); if (!res.headersSent) res.writeHead(500); res.end(); });
  }
  if (req.url.startsWith("/api/overpass")) return relay(req, res, "overpass").catch(err => { console.error(err); if (!res.headersSent) res.writeHead(500); res.end(); });
  if (req.url.startsWith("/api/sparql")) return relay(req, res, "sparql").catch(err => { console.error(err); if (!res.headersSent) res.writeHead(500); res.end(); });
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  return serveStatic(req, res);
}).listen(PORT, () => console.log(`Placelore listening on ${PORT}`));
