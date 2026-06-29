FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ sqlite3 postgresql-client \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY . .

# Create data directories for backups
RUN mkdir -p /data/journal /data/backups /data/shutdown-state

ENV NODE_ENV=production
ENV PORT=3002

EXPOSE 3002

CMD ["node", "server/server-3002.js"]
