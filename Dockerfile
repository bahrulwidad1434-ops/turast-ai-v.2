FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY data ./data
COPY README.md ./

ENV NODE_ENV=production
ENV PORT=8787

EXPOSE 8787

CMD ["node", "--import", "tsx", "src/server/index.ts"]