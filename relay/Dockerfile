# Build from the repo root: docker build -f relay/Dockerfile .
FROM node:24-slim
WORKDIR /relay
COPY relay/package.json ./
COPY relay/src ./src
USER node
CMD ["node", "src/node.ts"]
