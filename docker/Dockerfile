# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.3.14
ARG BINARY_SOURCE=build

# Debian (glibc) everywhere: the runtime needs glibc for curl-impersonate, and
# bun's compiler emits a musl-linked binary for gnu targets when run on an
# alpine host (measured: --target bun-linux-x64 from musl bun -> ld-musl
# interpreter), so the build stages match the runtime's libc.
FROM --platform=$BUILDPLATFORM oven/bun:${BUN_VERSION}-debian AS base
WORKDIR /app

FROM base AS frontend-build
WORKDIR /app/public
COPY public/package.json public/bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile
COPY public/ ./
RUN bun run --bun build

FROM base AS production-dependencies
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

FROM base AS build
ARG TARGETARCH
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
COPY tools/build-binary.mjs tools/binary-entry.mjs tools/binary-frontend.mjs ./tools/
COPY --from=frontend-build /app/public/dist ./public/dist
# gnu target (no -musl): the runtime image is Debian — curl-impersonate is
# glibc-only, which is why the base moved off Alpine in the first place.
RUN case "$TARGETARCH" in \
      amd64) bun_arch=x64 ;; \
      arm64) bun_arch=arm64 ;; \
      *) echo "Unsupported architecture: $TARGETARCH"; exit 1 ;; \
    esac && \
    bun --no-env-file tools/build-binary.mjs \
      --target "bun-linux-${bun_arch}" --outfile /out/qwen2api

# CI selects this stage to package the same executable it just compiled.
FROM scratch AS prebuilt
ARG TARGETARCH
COPY pkg_dist/docker/${TARGETARCH}/qwen2api /out/qwen2api

FROM ${BINARY_SOURCE} AS selected-binary

# curl-impersonate v0.6.1, pinned per-arch tarballs with sha256 verification.
# Only the statically linked curl-impersonate-chrome binary ships (libc/libz
# only dynamic deps): plain Node TLS is Baxia-punished on completions, the
# Chrome ClientHello + HTTP/2 of this binary passes (2026-11-21 live proof,
# docs/et0-live-integration-2026-11-21.md). Checksums computed from the
# lwthiker release assets themselves.
FROM debian:bookworm-slim AS curl-impersonate
ARG TARGETARCH
ARG CURL_IMPERSONATE_VERSION=v0.6.1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    case "$TARGETARCH" in \
      amd64) ci_arch=x86_64; ci_sha256=fa1e1614f7ba69ccc66721a0f38be457a3647eb64c75d66974b56186e3316b12 ;; \
      arm64) ci_arch=aarch64; ci_sha256=b45f14366e4766fbd70a54a07182d2ffaf1e8aed0f0d85aa4e0183fa9d041694 ;; \
      *) echo "Unsupported architecture: $TARGETARCH"; exit 1 ;; \
    esac && \
    tarball="curl-impersonate-${CURL_IMPERSONATE_VERSION}.${ci_arch}-linux-gnu.tar.gz" && \
    curl -fsSLO "https://github.com/lwthiker/curl-impersonate/releases/download/${CURL_IMPERSONATE_VERSION}/${tarball}" && \
    echo "${ci_sha256}  ${tarball}" | sha256sum -c - && \
    mkdir -p /out && \
    tar -xzf "$tarball" -C /out curl-impersonate-chrome && \
    chmod 0755 /out/curl-impersonate-chrome

# Debian (glibc) runtime: required by curl-impersonate. ca-certificates is
# installed explicitly: bun ships its own TLS store, but curl-impersonate
# needs /etc/ssl/certs/ca-certificates.crt on disk (verified by the jik.5
# container smoke: curl error 77 without it).
FROM oven/bun:${BUN_VERSION}-debian AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app/data /app/logs /app/caches
WORKDIR /app
ENV NODE_ENV=production \
    QWEN2API_RUNTIME_DIR=/app
COPY --from=selected-binary --chmod=0755 /out/qwen2api /usr/local/bin/qwen2api
COPY --from=curl-impersonate --chmod=0755 /out/curl-impersonate-chrome /usr/local/bin/curl-impersonate-chrome

EXPOSE 3000
ENTRYPOINT ["/usr/local/bin/qwen2api"]
CMD []
