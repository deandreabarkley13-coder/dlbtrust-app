FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

RUN mkdir -p data

EXPOSE 3001

CMD ["node", "app.js"]
