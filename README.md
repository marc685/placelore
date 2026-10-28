# Placelore

A field guide to wherever you are. Use your phone's GPS or type a town name to see the place's history, where the names of its rivers come from, walking trails, camping and picnic spots, farms, wildlife and birds, climate, geology and mountains, all on one map with links to read more.

Live site: https://placelore-1083758112018.europe-west1.run.app (Cloud Run, redeploys on every push to main)

Data: OpenStreetMap, Wikipedia and Wikidata, iNaturalist, Open-Meteo, Macrostrat.

## How it runs

`server.js` is a small Node server with no framework. It serves `index.html` and the `/api/chat` route behind **Ask about this place**. The browser sends a text summary of what the page has already loaded, and the server streams Claude's answer back. Everything else comes straight from public APIs in the browser.

The assistant needs an Anthropic API key in the `ANTHROPIC_API_KEY` environment variable. On Cloud Run, keep it in Secret Manager and expose it to the service as that variable. Without a key, the rest of the app works and the assistant says it isn't set up yet.

Run locally: `npm install && ANTHROPIC_API_KEY=... npm start`, then open http://localhost:8080.

## Map data for South Africa

The app keeps its own copy of the OpenStreetMap data it needs for South Africa, so places to stay, food and fun, help, trails, rivers, farms and peaks load in milliseconds instead of waiting on the public map servers.

- `Dockerfile` (first stage) downloads South Africa from Geofabrik, keeps only the tags the app uses (`osmium tags-filter`), exports them (`osmium export`) and runs `tools/build-places.mjs`, which writes one file per kind of place, cut into 0.1° cells, to `places/`.
- `server.js` answers `/api/places?kind=stay|fun|help|points|lines|paths&lat=&lon=&r=` from those files. Outside the data's bounds, or if the data is missing, it answers 404 and the app falls back to the public map servers.
- Marked hiking-route relations aren't in the export; the app still fetches those from the public servers, in the background.
- The data is rebuilt on every deploy; a weekly scheduled Cloud Build run keeps it fresh. A build takes 10-20 minutes, so the Cloud Build trigger's timeout must be at least 40 minutes.
