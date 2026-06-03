FROM node:20-slim

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy application code
COPY . .

# Create data directory (volume will be mounted here)
RUN mkdir -p /data

# Set environment
ENV NODE_ENV=production
ENV PORT=8080
ENV DB_PATH=/data/dlbtrust.db

EXPOSE 8080

CMD ["node", "app.js"]
