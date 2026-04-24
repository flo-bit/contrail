FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY src/ src/
COPY app/ app/
COPY bin/ bin/

CMD ["npx", "tsx", "bin/ingest.ts"]
