FROM node:22-slim

# Tools the claude CLI uses for some of its features
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# Install the Claude Code CLI globally; auth comes from the mounted ~/.claude
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
USER node

ENV HOME=/home/node
CMD ["node", "--experimental-strip-types", "--no-warnings", "--env-file=.env", "src/poller.ts"]
