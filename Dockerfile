# BrainOutput Community Edition — zero-dependency Node app.
# Runs as a non-root user; the store lives on a volume so an instance is disposable and its data is not.
FROM node:22-alpine
RUN addgroup -S bo && adduser -S -G bo bo
# The OpenCode coding runtime, bundled (founder decision: "bundle runtime in image") so coding
# tasks get iterative workers out of the box. PINNED to an exact version via ARG — never
# "latest": a rebuild reproduces the same runtime. node:22-alpine is musl; opencode-ai's
# postinstall selects the musl build (opencode-linux-{x64,arm64}-musl) and verifies it executes,
# and the explicit `--version` checks below make the BUILD FAIL LOUDLY if the runtime cannot run
# on this base — as root AND as the bo user it will run as.
ARG OPENCODE_VERSION=1.18.11
# git is part of the runtime contract, not an extra daemon: the adapter's work evidence
# (changed-files / no-work guard) is computed from git, and opencode snapshots through git.
RUN apk add --no-cache git \
 && npm install -g "opencode-ai@${OPENCODE_VERSION}" \
 && opencode --version \
 && su -s /bin/sh - bo -c "opencode --version"
# The adapter's first search path (BO_OPENCODE_BIN, then ~/.opencode/bin/opencode).
ENV BO_OPENCODE_BIN=/usr/local/bin/opencode
WORKDIR /app
COPY --chown=bo:bo . /app
RUN rm -rf /app/.git /app/node_modules /app/*.test.mjs
# Create the data directory owned by the app user BEFORE declaring the volume: Docker seeds a new
# volume from the image, so this is what makes a non-root container able to write its own store.
RUN mkdir -p /data && chown bo:bo /data
USER bo
ENV BO_CE_DATA=/data BO_CE_WEB_PORT=4177 BO_CE_WEB_HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 4177
# Refuses to start on 0.0.0.0 without BO_CE_ACCESS_TOKEN — pass one in.
CMD ["node", "bo-community.mjs", "serve"]
