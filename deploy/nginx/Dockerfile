# syntax=docker/dockerfile:1.7
# Dashboard (Nuxt SPA) built and served by nginx, which also proxies /api and /ingest to replayd (PRD §9).
FROM node:22-alpine AS dashboard
WORKDIR /app
COPY dashboard/package.json dashboard/pnpm-lock.yaml dashboard/.npmrc ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm i -g pnpm@10.28.0 && pnpm install --frozen-lockfile --ignore-scripts
COPY dashboard/ ./
RUN NUXT_TELEMETRY_DISABLED=1 pnpm exec nuxt prepare && pnpm build

# SDK IIFE + lazy chunks for script-tag installs (`/_rp/sdk/<version>/replayd.min.js`, PRD §4.13/§5.2).
# Source maps stay out of the public directory.
FROM node:22-alpine AS sdk
WORKDIR /sdk
COPY sdk/ ./
RUN --mount=type=secret,id=ca,required=false \
    if [ -s /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    npm i -g pnpm@10.28.0 && pnpm install --frozen-lockfile
RUN cd packages/core && node ../../scripts/build.mjs build.json \
 && v=$(node -p "require('./package.json').version") \
 && mkdir -p /out/$v \
 && cp dist/replayd.min.js dist/replay.js dist/capacitor.js dist/worker.js /out/$v/ \
 && sed -i 's#//[#@] sourceMappingURL=.*##' /out/$v/*.js \
 && cp -r /out/$v /out/latest \
 && gzip -k9 /out/*/*.js

FROM nginx:1.29.8-alpine
COPY deploy/nginx/replayd.conf /etc/nginx/conf.d/default.conf
COPY --from=dashboard /app/.output/public /usr/share/nginx/html
COPY --from=sdk /out /usr/share/nginx/sdk
