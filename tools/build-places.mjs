// Turns an OpenStreetMap extract (exported by osmium as GeoJSON lines) into Placelore's own
// place data: one file per kind of place, split into 0.1° cells so the server can read just the
// cells around a point. Usage: node build-places.mjs features.geojsonseq out-dir [bounds]
import fs from "node:fs";
import readline from "node:readline";
import zlib from "node:zlib";
import path from "node:path";

const [, , input, outDir, boundsArg] = process.argv;
if (!input || !outDir) { console.error("usage: node build-places.mjs features.geojsonseq out-dir [minlon,minlat,maxlon,maxlat]"); process.exit(1); }

const CELL = 10; // cells per degree
const cellKey = (lat, lon) => `${Math.floor(lat * CELL)}_${Math.floor(lon * CELL)}`;
const r5 = x => Math.round(x * 1e5) / 1e5;

// Only the tags the app reads are kept
const KEEP = new Set(["name", "name:en", "name:af", "tourism", "amenity", "leisure", "sport", "route", "place", "landuse", "shop", "craft",
  "natural", "historic", "waterway", "highway", "sac_scale", "surface", "ele", "prominence", "wikipedia", "wikidata", "website",
  "contact:website", "phone", "contact:phone", "contact:mobile", "opening_hours", "cuisine", "stars", "rooms", "operator", "fee",
  "toilets", "drinking_water", "power_supply", "tents", "bbq", "fireplace", "covered", "emergency", "access", "produce", "crop",
  "start_date", "inscription", "description", "protection_title", "boundary", "network", "distance", "ref", "guest_house", "farm",
  "accommodation", "tracktype", "name:etymology", "name:etymology:wikidata", "name:etymology:wikipedia", "alt_name", "old_name"]);

// The same selections the app used to ask the public map servers for
const has = (t, k, re) => t[k] !== undefined && re.test(t[k]);
const KINDS = {
  stay: t => has(t, "tourism", /^(hotel|motel|hostel|guest_house|apartment|chalet|farmstay)$/) || t.accommodation === "farmstay",
  fun: t => has(t, "amenity", /^(restaurant|cafe|bar|pub|nightclub|biergarten|cinema|theatre|arts_centre)$/)
    || has(t, "leisure", /^(playground|water_park|amusement_arcade|miniature_golf|trampoline_park|golf_course|sports_centre|stadium|fitness_centre|horse_riding|marina|ice_rink)$/)
    || (t.leisure === "swimming_pool" && t.name) || has(t, "tourism", /^(zoo|theme_park|aquarium)$/) || has(t, "sport", /squash|tennis|4wd|offroad|off_road/),
  help: t => has(t, "amenity", /^(hospital|clinic|doctors|police|pharmacy|fuel)$/),
  points: t => has(t, "tourism", /^(camp_site|caravan_site|picnic_site|viewpoint|wine_cellar|alpine_hut|wilderness_hut)$/)
    || t.leisure === "picnic_site" || (t.leisure === "nature_reserve" && t.name) || (t.boundary === "protected_area" && t.name)
    || t.place === "farm" || (t.landuse === "farmyard" && t.name) || t.shop === "farm" || has(t, "craft", /^(winery|brewery|distillery|beekeeper)$/)
    || (has(t, "natural", /^(peak|volcano|hill)$/) && t.name) || (t.historic && t.name),
  lines: t => (has(t, "highway", /^(path|bridleway|footway|track|steps)$/) && t.name) || (has(t, "waterway", /^(river|stream|canal)$/) && t.name),
  paths: t => has(t, "highway", /^(path|bridleway)$/) && !t.name
};
const LANDUSE = ["vineyard", "orchard", "farmland", "meadow", "greenhouse_horticulture|plant_nursery", "forest"];
const landuseCode = t => LANDUSE.findIndex(l => new RegExp(`^(${l})$`).test(t.landuse || ""));

// Douglas-Peucker on [lat, lon] pairs: about 3 m tolerance keeps paths true but much lighter
function simplify(pts, tol = 0.00003) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop(); let max = 0, idx = -1;
    const [y1, x1] = pts[a], [y2, x2] = pts[b], dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1e-12;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * pts[i][1] - dx * pts[i][0] + x2 * y1 - y2 * x1) / len; if (d > max) { max = d; idx = i; } }
    if (max > tol) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
// A long river is cut into one piece per cell, so a query reads only the pieces near it
function pieces(pts) {
  const out = []; let cur = [pts[0]], key = cellKey(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) {
    const k = cellKey(pts[i][0], pts[i][1]);
    cur.push(pts[i]);
    if (k !== key) { out.push([key, cur]); cur = [pts[i]]; key = k; }
  }
  if (cur.length > 1) out.push([key, cur]);
  return out;
}
function centre(geom) {
  if (geom.type === "Point") return [geom.coordinates[1], geom.coordinates[0]];
  let minX = 180, minY = 90, maxX = -180, maxY = -90;
  const walk = c => { if (typeof c[0] === "number") { minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]); minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]); } else c.forEach(walk); };
  walk(geom.coordinates);
  return [(minY + maxY) / 2, (minX + maxX) / 2];
}
const lineCoords = geom => geom.type === "LineString" ? [geom.coordinates] : geom.type === "MultiLineString" ? geom.coordinates
  : geom.type === "Polygon" ? [geom.coordinates[0]] : geom.type === "MultiPolygon" ? geom.coordinates.map(p => p[0]) : [];

const cells = {}; for (const k of [...Object.keys(KINDS), "landuse"]) cells[k] = new Map();
const add = (kind, key, rec) => { const m = cells[kind]; let a = m.get(key); if (!a) m.set(key, a = []); a.push(rec); };
let bounds = boundsArg ? boundsArg.match(/-?\d+(\.\d+)?/g)?.map(Number) : null;
let n = 0, kept = 0, minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;

const rl = readline.createInterface({ input: fs.createReadStream(input), crlfDelay: Infinity });
for await (let line of rl) {
  line = line.replace(/^\x1e/, "").trim(); if (!line) continue;
  n++;
  let f; try { f = JSON.parse(line); } catch { continue; }
  const props = f.properties || {}, geom = f.geometry; if (!geom) continue;
  const id = String(f.id ?? props["@id"] ?? ""), type = { n: "n", w: "w", r: "r", a: "w" }[id[0]] || "n", num = Number(id.slice(1)) || 0;
  const tags = {}; for (const [k, v] of Object.entries(props)) if (KEEP.has(k)) tags[k] = v;
  const [lat, lon] = centre(geom);
  minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat); minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
  let any = false;
  for (const [kind, test] of Object.entries(KINDS)) {
    if (!test(tags)) continue;
    any = true;
    if (kind === "lines" || kind === "paths") {
      for (const ring of lineCoords(geom)) {
        const pts = simplify(ring.map(([x, y]) => [r5(y), r5(x)]));
        if (pts.length > 1) for (const [key, part] of pieces(pts)) add(kind, key, { t: type, i: num, g: tags, c: part });
      }
    } else add(kind, cellKey(lat, lon), { t: type, i: num, g: tags, a: r5(lat), o: r5(lon) });
  }
  const lu = landuseCode(tags);
  if (lu >= 0 && type !== "n") { any = true; add("landuse", cellKey(lat, lon), [r5(lat), r5(lon), lu]); }
  if (any) kept++;
}

fs.mkdirSync(outDir, { recursive: true });
const summary = {};
for (const [kind, map] of Object.entries(cells)) {
  // One data file per kind (gzip blocks back to back) and an index of where each cell's block is
  const fd = fs.openSync(path.join(outDir, `${kind}.bin`), "w"); let offset = 0, records = 0; const index = {};
  for (const [key, recs] of map) {
    const buf = zlib.gzipSync(JSON.stringify(recs), { level: 9 });
    fs.writeSync(fd, buf); index[key] = [offset, buf.length]; offset += buf.length; records += recs.length;
  }
  fs.closeSync(fd);
  fs.writeFileSync(path.join(outDir, `${kind}.idx.json`), JSON.stringify(index));
  summary[kind] = { cells: map.size, records, bytes: offset };
}
if (!bounds || bounds.length !== 4) bounds = [minLon, minLat, maxLon, maxLat];
fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({ built: new Date().toISOString(), cell: CELL, bounds, features: kept }));
console.log(`read ${n} features, kept ${kept}`); console.table(summary);
