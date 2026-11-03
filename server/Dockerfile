# syntax=docker/dockerfile:1.7
# Static musl binary → distroless (PRD §5.1).
FROM rust:1-alpine AS build
# The official image already ships gcc + musl-dev (needed by mimalloc), so no apk step is required.
WORKDIR /src
COPY . .
# Optional extra CA bundle for build environments behind a TLS-inspecting proxy:
#   docker build --secret id=ca,src=/path/ca.crt ...
RUN --mount=type=secret,id=ca,required=false \
    --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    if [ -s /run/secrets/ca ]; then export CARGO_HTTP_CAINFO=/run/secrets/ca SSL_CERT_FILE=/run/secrets/ca; fi; \
    cargo build --release --locked -p replayd && cp target/release/replayd /replayd

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /replayd /replayd
USER nonroot
EXPOSE 8080
ENTRYPOINT ["/replayd"]
