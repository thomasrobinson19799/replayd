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

FROM nginx:1.29.8-alpine
COPY deploy/nginx/replayd.conf /etc/nginx/conf.d/default.conf
COPY --from=dashboard /app/.output/public /usr/share/nginx/html
