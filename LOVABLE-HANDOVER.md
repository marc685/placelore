# Placelore: handover for Lovable

Paste everything below the line into Lovable as the first prompt. The working reference version is a single file, `index.html`, in https://github.com/marc685/placelore. Lovable should follow it for behaviour and API calls, and rebuild it as a proper React app.

---

Build **Placelore**, a mobile-first web app (installable as a PWA) that tells the user the story of any place they visit.

## Who it's for and the core flow
A traveller standing in a town or out on a farm road. They either:

1. Tap **"Where am I?"**: use the phone's GPS (`navigator.geolocation`, high accuracy), reverse-geocode to the nearest town, then load that place, or
2. Type a **town name** into a search box. If there are several matches, show a pick list (name plus full address).

A **radius selector** (5 / 10 / 20 / 30 km, default 10) controls how far around the point the map searches. Changing it reloads the place.

Keep the last 8 places in "Recently visited" on the start screen (localStorage). Support a shareable URL: `?q=<name>&lat=<lat>&lon=<lon>`.

## Screen layout (one long scroll, phone first)
- Sticky header: app name, search box plus button, "Where am I?" button, radius select.
- Place band: kind ("You are here · town"), large place name, region and country, coordinates, elevation, live weather pill ("Now: 18°C, partly cloudy, wind 12 km/h").
- Sticky row of chapter chips (scrolls sideways) linking to: Overview · Map · History · Rivers & names · Trails & camping · Wildlife & birds · Climate · Geology & mountains · Farms · Nearby sights.
- Each section loads on its own with a spinner line, an error line with **Try again**, or a friendly empty state. One slow source must never block the rest.
- Every section ends with "read more" link pills that open in a new tab.

## Sections and their data sources (all free, no API keys, CORS-enabled)

### 1. Overview
- Find the place's Wikipedia article, in this order: Nominatim `extratags.wikipedia` → Wikidata sitelink from `extratags.wikidata` → Wikipedia search, choosing the result whose coordinates are within 40 km.
- Fetch the full plain-text article: `en.wikipedia.org/w/api.php?action=query&prop=extracts|pageimages|pageprops&explaintext=1&exsectionformat=wiki&titles=…&redirects=1&piprop=thumbnail&pithumbsize=800&ppprop=wikibase_item&format=json&formatversion=2&origin=*`. Split it into sections on `== Heading ==` markers. Drop References, See also, External links, Notes, and similar.
- Show: the intro paragraphs, a facts card (image, description, population P1082, founded P571, elevation P2044, area P2046, nickname P1449; from Wikidata `wbgetentities`), and **"Where the name comes from"**: the Etymology/Name section, or else sentences matching "named after / derived from / means…", plus Wikidata P138 "named after".
- "Interesting facts": up to 8 sentences from the article containing words like oldest, first, largest, highest, only, famous, "known as", founded in.

### 2. Map (Leaflet)
- Base layers: OpenTopoMap terrain (default), OSM street map, Esri World Imagery satellite. Optional overlay: Waymarked Trails hiking routes.
- Dashed circle for the search radius, and a blue dot when the location came from GPS.
- Layers the user can switch on and off, each with its own colour and icon: Trails, Camping, Picnic, Farms, Peaks, Rivers, Historic, Viewpoints & reserves, Encyclopaedia (Wikipedia geosearch).
- Popups show the name, details, and links: **Directions** (Google Maps `dir/?api=1&destination=lat,lon`), OSM, Wikipedia, Website.
- Every list item elsewhere has a **"Show on map"** button that scrolls to the map, zooms in and opens the popup.

Data comes from the **Overpass API** (POST; fall back to the next mirror if one fails: overpass-api.de, overpass.kumi.systems, overpass.private.coffee). Use two queries in parallel:
- *Lines* (`out tags geom(<bbox>)`): `relation[route~hiking|foot|walking]`, `way[highway~path|bridleway]` (radius capped at 12 km), named `way[highway~footway|track|steps]`, named `way[waterway~river|stream|canal]`.
- *Points* (`out tags center`): tourism camp_site/caravan_site/picnic_site/viewpoint/wine_cellar/alpine_hut/wilderness_hut; leisure picnic_site and named nature_reserve; named protected_area; place=farm; named landuse=farmyard; shop=farm; craft winery/brewery/distillery/beekeeper; named natural peak/volcano/hill; named historic=*; named waterway=river relations. Then `out count` for landuse vineyard / orchard / farmland / meadow / greenhouse & nursery / forest.

### 3. History
- All article sections whose heading matches history, settlement, colonial, founding, prehistory or archaeology, including their subsections. Collapse long ones after 6 paragraphs ("Continue reading").
- If a "History of <Title>" article exists, show its chapters as expandable blocks.
- **T.V. Bulpin, *Discovering Southern Africa* panel.** The book is under copyright, so never reproduce its text. Show links: search inside the book on Google Books (`tbm=bks`, query `"<place>" Bulpin "Discovering Southern Africa"`), Internet Archive search, a shopping search, SA History Online search for the place, and Bulpin's Wikipedia page. Add a **"My notes from the book"** text box saved per place (localStorage now; Supabase later if accounts are added).
- "Historic sites nearby" list from OSM `historic=*`: items with Wikipedia first, then nearest first.
- Links: full article, "history of X" web search, Old Maps Online at the location, Wikimedia Commons photos.

### 4. Rivers and where their names come from
- Group river and stream ways by name and add up the length inside the area. Rivers come first, then by length; show the top 10, and list the rest as names only.
- For each one: OSM tags `name:etymology*` → Wikidata (description, length P2043, named after P138) → Wikipedia article (via tag, sitelink, or a search accepted only if its coordinates are within 200 km). Show the Etymology section, or else name-origin sentences, or else the first 2 intro sentences. Otherwise say "No recorded origin for this name yet".
- Links: Wikipedia, and a "<river> name origin meaning" web search.

### 5. Trails, camping and picnic spots
- Trails: marked routes (with network level and length within the area, linking to `hiking.waymarkedtrails.org/#route?id=<relation>`), then named paths over 150 m, longest first, showing type, sac_scale difficulty and surface. Note the total length of unnamed footpaths.
- Camping: kind, free, toilets, water, power, tents allowed, operator, distance. Picnic: braai/BBQ, fireplace, toilets, covered. Viewpoints and reserves.
- Long lists show 12 and then "Show all N".
- Add a safety note: check access rules and conditions before setting out.

### 6. Wildlife and birds (iNaturalist)
- `api.inaturalist.org/v1/observations/species_counts?lat&lng&radius=<km, at least 10>&quality_grade=research&per_page=N&locale=en`.
- Tabs: Birds (`iconic_taxa=Aves`), Mammals, Reptiles & frogs (`Reptilia,Amphibia`), Butterflies & moths (`taxon_id=47157`), Wildflowers & plants, Fish (`Actinopterygii`).
- Photo card grid: common name, scientific name in italics, number of sightings, a conservation badge when present, and iNat and Wikipedia links.
- Also show the article's flora/fauna sections. Links: iNaturalist explore, eBird hotspots.

### 7. Climate (Open-Meteo)
- `archive-api.open-meteo.com/v1/archive` daily `temperature_2m_max, temperature_2m_min, precipitation_sum, sunshine_duration` from 2015-01-01 to 2024-12-31. Average these into 12 months.
- Stat tiles: warmest-month high, coldest-month low, yearly rainfall, wettest and driest month, sunshine hours per day.
- SVG or Recharts chart: rainfall bars plus high and low temperature lines.
- **Köppen climate type** worked out from the monthly data, hemisphere-aware (the logic is in `koppen()` in the reference `index.html`), with a plain-English name, e.g. "Csb: Mediterranean, warm dry summers".
- Current weather comes from `api.open-meteo.com/v1/forecast?current=temperature_2m,weather_code,wind_speed_10m`, using WMO codes for the words.

### 8. Geology and mountains
- Macrostrat `macrostrat.org/api/v2/geologic_units/map?lat&lng`, falling back to `/api/v2/mobile/map_query?lat&lng&z=11`. Show up to 4 rock units: name, age range in million or billion years, rock types, description, and a "read about <formation>" link.
- Peaks from OSM, highest first, with elevation, prominence and distance.
- The article's geography/geology sections. Links: Macrostrat map, PeakVisor.

### 9. Farms and the land
- Farms, wine estates, farm shops, breweries and beekeepers with produce, crop and opening hours.
- Land-use pills (e.g. "312 vineyard parcels").
- The article's economy/agriculture sections.
- Say plainly that many farms are not on the map.

### 10. Nearby sights
- Wikipedia `generator=geosearch` (10 km, 20 results) with a thumbnail, short description, 3-sentence extract and distance, nearest first. These are also the map's "Encyclopaedia" pins.

## Design direction
- Feel: a field guide or topographic map. Not a generic SaaS look, no emoji as icons.
- Fonts: Zilla Slab (headings), Source Sans 3 (body), IBM Plex Mono (numbers, coordinates, labels).
- Light palette: paper `#eef1ec`, surface `#ffffff`, ink `#1d2a24`, muted `#5b6b62`, line `#d3dbd4`, pine accent `#24553f`, ochre `#a8761c`, river blue `#2f6f9a`, trail rust `#9b4a2a`.
- Dark palette: paper `#121815`, surface `#1a221e`, ink `#e4ebe6`, pine `#6cbf95`, ochre `#e0b357`, river `#6fb0dc`, trail `#e08a62`.
- Rounded 10–12 px cards only where needed. Chip-style link pills, readable 65-character text measure, 44 px touch targets.
- Must work at 360–400 px wide with no sideways scrolling.

## Technical notes
- React + Vite + Tailwind + react-leaflet. TanStack Query for each data source (cache per place and radius; retry once).
- No backend is needed; every API is public and CORS-enabled. Send Nominatim no more than about 1 request per second and debounce the search box (no search-as-you-type faster than that).
- Make it a PWA (manifest plus service worker): cache the app shell, and later the last places visited for areas with no signal.
- Show attribution in the footer: © OpenStreetMap contributors, Wikipedia/Wikidata (CC BY-SA), iNaturalist, Open-Meteo, Macrostrat, OpenTopoMap, Esri.
- GPS needs HTTPS (Lovable hosting provides this).

## Ideas for later
- Offline packs: download a place before a trip.
- Afrikaans Wikipedia (and other languages) as a fallback.
- "Plan a day here": suggested walk, picnic and farm-stall route.
- Accounts (Supabase) so Bulpin notes and favourite places sync across devices.
- An AI "ask about this place" chat grounded in the loaded data.
