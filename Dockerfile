# syntax=docker/dockerfile:1
FROM oven/bun:1.4.2 AS base
WORKDIR /app

FROM base AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY bun-patches ./bun-patches
COPY packages/ui/package.json ./packages/ui/
COPY packages/web/package.json ./packages/web/
COPY packages/electron/package.json ./packages/electron/
COPY packages/mobile/package.json ./packages/mobile/
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS builder
WORKDIR /app
COPY . .
RUN bun run build:web

FROM oven/bun:1.4.2 AS runtime
WORKDIR /home/pichamber

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  ca-certificates \
  git \
  less \
  openssh-client \
  python3 \
  && rm -rf /var/lib/apt/lists/*

# Replace the base image's 'bun' user (UID 1000) with 'pichamber'
# so mounted volumes with 1000:1000 ownership work correctly.
RUN userdel bun \
  && groupadd -g 1000 pichamber \
  && useradd -u 1000 -g 1000 -m -s /bin/bash pichamber \
  && chown -R pichamber:pichamber /home/pichamber

RUN mkdir -p /home/pichamber/.local /home/pichamber/.config /home/pichamber/.ssh \
  /home/pichamber/.pi/agent /home/pichamber/workspaces \
  && chown -R pichamber:pichamber /home/pichamber

LABEL org.opencontainers.image.source="https://github.com/RyderAsKing/PiChamber" \
  org.opencontainers.image.title="PiChamber" \
  org.opencontainers.image.description="PiChamber server"

# cloudflared 2026.3.0 multi-architecture image index. Keep the digest pinned
# so amd64 and arm64 builds resolve reproducibly from the same release.
COPY --from=cloudflare/cloudflared:2026.3.0@sha256:6b599ca3e974349ead3286d178da61d291961182ec3fe9c505e1dd02c8ac31b0 /usr/local/bin/cloudflared /usr/local/bin/cloudflared

ENV NODE_ENV=production \
  PICHAMBER_DEPLOYMENT_KIND=docker

COPY scripts/docker-entrypoint.sh /home/pichamber/pichamber-entrypoint.sh

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/web/node_modules ./packages/web/node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/packages/web/package.json ./packages/web/package.json
COPY --from=builder /app/packages/web/bin ./packages/web/bin
COPY --from=builder /app/packages/web/server ./packages/web/server
COPY --from=builder /app/packages/web/dist ./packages/web/dist

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:3000/health').then((response) => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"]

ENTRYPOINT ["sh", "/home/pichamber/pichamber-entrypoint.sh"]
