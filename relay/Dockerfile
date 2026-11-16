# Build from the repo root: docker build -f relay/Dockerfile .
# node:24-slim, resolved 2026-11-16
FROM node:24-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
WORKDIR /relay
COPY relay/package.json ./
COPY relay/src ./src
USER node
CMD ["node", "src/node.ts"]
