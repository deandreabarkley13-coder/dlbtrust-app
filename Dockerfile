FROM node:22-slim

# pg_dump must be at least the server's major version (Northflank addon runs 16);
# bookworm ships postgresql-client 15, so take the client from PGDG.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
       -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
       > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ sqlite3 postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Create data directories for backups
RUN mkdir -p /data/journal /data/backups /data/shutdown-state

ENV NODE_ENV=production
ENV PORT=3002

EXPOSE 3002

CMD ["node", "server/server-3002.js"]
