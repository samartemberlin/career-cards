FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54

# serve would be PID 1, which ignores SIGTERM unless handled and never reaps orphaned children.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Separate from COPY . . so a source-only change doesn't re-run npm install.
COPY package*.json ./
RUN npm ci --omit=dev

# Pin to the version MODEL_TOOL_FLAGS was checked against; bump both together.
RUN npm install -g @anthropic-ai/claude-code@2.1.322

# App source; career-ops/ is included as a checked-out submodule.
COPY . .

# Writable HOME so the claude CLI can create ~/.claude.
ENV HOME=/home/node

# glibc gives each thread its own malloc arena, so native memory grows with the host's core count. Two arenas lowered
# a sample run's peak in a 512 MB container from 428 to 375 MB.
ENV MALLOC_ARENA_MAX=2

# App files stay root-owned and read-only for node.
USER node

ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/main.ts"]
CMD ["serve"]
