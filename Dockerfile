# --- Wirebase: single-container Node app (Express + Socket.IO + Baileys) ---
FROM node:20-alpine

# Baileys/qrcode/bcryptjs are pure JS - no build toolchain needed. tini gives clean signal
# handling (Ctrl+C / docker stop) so Baileys can log out gracefully instead of hanging.
RUN apk add --no-cache tini

WORKDIR /app

# Install dependencies first (better layer caching on rebuilds)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY index.js ./
COPY src ./src
COPY public ./public
COPY static ./static

# Baileys auth sessions and downloaded WhatsApp media live here - mount volumes over these
# paths (see docker-compose.yml) so linked numbers and media survive restarts/upgrades.
RUN mkdir -p /app/sessions /app/media
VOLUME ["/app/sessions", "/app/media"]

ENV NODE_ENV=production
EXPOSE 4000

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "index.js"]