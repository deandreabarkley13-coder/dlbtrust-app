FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

RUN mkdir -p data

EXPOSE 3001

ENV NODE_ENV=production
ENV PORT=3001

CMD ["node", "app.js"]
