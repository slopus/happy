FROM node:22-slim AS base

ENV NODE_ENV=production
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install -g yarn@1.22.22 && yarn install --frozen-lockfile || yarn install

COPY sources ./sources
COPY prompts ./prompts
COPY tsconfig.json ./

CMD ["yarn", "start:api"]
