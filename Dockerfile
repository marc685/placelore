# --- Stage 1: Placelore's own map data for South Africa, built from OpenStreetMap (Geofabrik) ---
FROM node:20-bookworm-slim AS places
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY tools/build-places.mjs ./
ARG OSM_URL=https://download.geofabrik.de/africa/south-africa-latest.osm.pbf
# Keep only what the app shows (places to stay, food and fun, help, outdoor and historic places,
# land use, named trails and rivers, unnamed footpaths), then cut it into cells
RUN curl -fsSL --retry 3 -o sa.osm.pbf "$OSM_URL" \
 && osmium tags-filter sa.osm.pbf \
      nwr/tourism nwr/leisure nwr/sport nwr/historic nwr/accommodation=farmstay nwr/place=farm nwr/shop=farm \
      nwr/amenity=restaurant,cafe,bar,pub,nightclub,biergarten,cinema,theatre,arts_centre,hospital,clinic,doctors,police,pharmacy,fuel \
      nwr/craft=winery,brewery,distillery,beekeeper nwr/natural=peak,volcano,hill nwr/boundary=protected_area \
      nwr/landuse=farmyard,vineyard,orchard,farmland,meadow,greenhouse_horticulture,plant_nursery,forest \
      w/waterway=river,stream,canal w/highway=path,bridleway,footway,track,steps \
      -o filtered.osm.pbf \
 && osmium export filtered.osm.pbf -f geojsonseq --add-unique-id=type_id -o features.geojsonseq \
 && node --max-old-space-size=6144 build-places.mjs features.geojsonseq /build/places "$(osmium fileinfo -g header.boxes sa.osm.pbf)" \
 && rm -f sa.osm.pbf filtered.osm.pbf features.geojsonseq

# --- Stage 2: the app ---
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY index.html sw.js manifest.webmanifest icon-192.png icon-512.png ./public/
COPY i18n ./public/i18n
COPY --from=places /build/places ./places
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
