# Build the Lovable (Vite + React) app, then serve the static files with nginx on port 8080 for Cloud Run.
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci || npm install
COPY . .
# Lovable bakes VITE_* settings in at build time. If the project uses any (e.g. Supabase),
# pass them as build args in Cloud Build and uncomment these lines.
# ARG VITE_SUPABASE_URL
# ARG VITE_SUPABASE_PUBLISHABLE_KEY
RUN npm run build

FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
