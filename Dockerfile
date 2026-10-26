FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.js ./
COPY index.html i18n.js sw.js manifest.webmanifest icon-192.png icon-512.png ./public/
ENV PORT=8080
EXPOSE 8080
USER node
CMD ["node", "server.js"]
