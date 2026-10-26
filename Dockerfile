# Serial Web Viewer
# Serial access needs device mapping, e.g. --device /dev/ttyUSB0 (see docker-compose.yml)

# node:sqlite needs Node 22.13 or newer
FROM node:22-alpine

# Build tools in case serialport has no prebuilt binary for this platform
RUN apk add --no-cache python3 make g++ linux-headers eudev-dev

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js db.js ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/serial-viewer.db \
    PORT=3000

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/health || exit 1

# server.js closes the serial port and checkpoints SQLite on SIGTERM (docker stop)
STOPSIGNAL SIGTERM
USER node
CMD ["node", "server.js"]
