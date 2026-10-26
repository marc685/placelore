# Placelore

A field guide to wherever you are. Use your phone's GPS or type a town name to see the place's history, where the names of its rivers come from, walking trails, camping and picnic spots, farms, wildlife and birds, climate, geology and mountains, all on one map with links to read more.

Live site: https://placelore-1083758112018.europe-west1.run.app (Cloud Run, redeploys on every push to main)

Data: OpenStreetMap, Wikipedia and Wikidata, iNaturalist, Open-Meteo, Macrostrat.

## How it runs

`server.js` is a small Node server with no framework. It serves `index.html` and the `/api/chat` route behind **Ask about this place**. The browser sends a text summary of what the page has already loaded, and the server streams Claude's answer back. Everything else comes straight from public APIs in the browser.

The assistant needs an Anthropic API key in the `ANTHROPIC_API_KEY` environment variable. On Cloud Run, keep it in Secret Manager and expose it to the service as that variable. Without a key, the rest of the app works and the assistant says it isn't set up yet.

Run locally: `npm install && ANTHROPIC_API_KEY=... npm start`, then open http://localhost:8080.
