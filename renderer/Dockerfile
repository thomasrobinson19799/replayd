FROM node:22-bookworm-slim AS libraries
WORKDIR /build
COPY e2e/package.json e2e/pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
RUN npm install --no-save --ignore-scripts @rrweb/replay@2.2.0

FROM mcr.microsoft.com/playwright:v1.63.0-noble
USER root
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=libraries /build/node_modules /app/node_modules
COPY renderer/ /app/
RUN mkdir -p /renders && chown 65532:65532 /renders
USER 65532:65532
ENV HOME=/tmp
CMD ["node", "/app/service.mjs"]
