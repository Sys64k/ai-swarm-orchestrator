# ASO Hub image: Hub API/WebSocket server + Next.js dashboard.
# Workers do not run in containers; they need direct access to their host's hardware and toolchains.

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/hub/package.json packages/hub/
COPY packages/worker/package.json packages/worker/
COPY packages/cli/package.json packages/cli/
COPY packages/dashboard/package.json packages/dashboard/
RUN npm ci
COPY packages packages
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build && npm run build:dashboard && npm prune --omit=dev

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  # The mounted project may be owned by a different uid than the container user.
  && git config --system safe.directory '*' \
  # World-writable so it works with whatever uid compose runs us as (ASO_UID).
  && mkdir -p /data && chmod 1777 /data
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOME=/data
WORKDIR /app
COPY --from=build /app /app
VOLUME /data
EXPOSE 7420 7421
ENTRYPOINT ["node", "packages/cli/dist/index.js"]
CMD ["start-hub", "--dir", "/project", "--no-architect"]
