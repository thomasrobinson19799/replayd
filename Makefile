# replayd — developer entry points (PRD §9, owner instructions).
SHELL := /bin/bash
COMPOSE := docker compose -f deploy/docker-compose.yml
PG_PORT ?= 55432
PG_URL ?= postgres://replayd:replayd@127.0.0.1:$(PG_PORT)/replayd?sslmode=disable
# Extra CA bundle for image builds behind a TLS-inspecting proxy (optional; empty = none).
comma := ,
REPLAYD_BUILD_CA ?= $(firstword $(wildcard /root/.ccr/ca-bundle.crt))
BUILD_SECRET := $(if $(REPLAYD_BUILD_CA),--secret id=ca$(comma)src=$(REPLAYD_BUILD_CA),) $(if $(HTTPS_PROXY),--build-arg HTTPS_PROXY --build-arg https_proxy=$(HTTPS_PROXY),)
REPLAYD_IMAGE ?= replayd:local
REPLAYD_NGINX_IMAGE ?= replayd-nginx:local

.PHONY: images help dev db db-down test test-server test-sdk test-dashboard bench up down logs migrate-hash install

help:
	@echo "make dev        Postgres + migrations in Docker, server (cargo run) + dashboard (nuxt dev) locally"
	@echo "make test       all checks: server fmt/clippy/test (+Postgres integration), sdk lint/test/size, dashboard lint/typecheck/build"
	@echo "make bench      SDK perf suite (Playwright, 4x CPU throttle) + server load test"
	@echo "make up         full stack in Docker (postgres, migrate, replayd, nginx+dashboard) on :8088"
	@echo "make down       stop the stack (volumes kept)"

install:
	cd sdk && pnpm install --frozen-lockfile
	cd dashboard && pnpm install --frozen-lockfile

db:
	$(COMPOSE) up -d --wait postgres
	$(COMPOSE) run --rm migrate

db-down:
	$(COMPOSE) down

dev: db
	@echo "replayd on :8080, dashboard on :3000"
	@trap 'kill 0' INT TERM; \
	( cd server && REPLAYD_DATABASE_URL='$(PG_URL)' REPLAYD_DATA_DIR=../data cargo run -p replayd ) & \
	( cd dashboard && pnpm dev ) & \
	wait

test: test-server test-sdk test-dashboard

test-server: db
	cd server && cargo fmt --check
	cd server && cargo clippy --all-targets -- -D warnings
	cd server && REPLAYD_TEST_DATABASE_URL='$(PG_URL)' cargo test

test-sdk:
	cd sdk && pnpm lint && pnpm test && pnpm size

test-dashboard:
	cd dashboard && pnpm lint && pnpm typecheck && pnpm build

bench:
	cd sdk && pnpm build && pnpm --filter @replayd/bench run bench
	./scripts/bench-server.sh

images:
	DOCKER_BUILDKIT=1 docker build --network host $(BUILD_SECRET) -t $(REPLAYD_IMAGE) server
	DOCKER_BUILDKIT=1 docker build --network host $(BUILD_SECRET) -t $(REPLAYD_NGINX_IMAGE) -f deploy/nginx/Dockerfile .

up: images
	$(COMPOSE) --profile app up -d --no-build --wait
	@echo "replayd is up: http://localhost:$${REPLAYD_HTTP_PORT:-8088}"

down:
	$(COMPOSE) --profile app down

logs:
	$(COMPOSE) --profile app logs -f --tail=100

migrate-hash:
	docker run --rm -v $(CURDIR)/server/migrations:/migrations arigaio/atlas:1.3.6 migrate hash --dir file:///migrations
