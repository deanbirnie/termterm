# termterm sync server.
#
# The server has no dependencies and Node 22 runs its TypeScript directly, so
# there is no build step. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t termterm-server .
FROM node:22-alpine
# Set by the release workflow to the version being released.
ARG VERSION=dev
ENV NODE_ENV=production TERMTERM_DB=/data/termterm.db PORT=8787 TERMTERM_VERSION=${VERSION}
LABEL org.opencontainers.image.title="termterm sync server" \
      org.opencontainers.image.source="https://github.com/deanbirnie/termterm" \
      org.opencontainers.image.version="${VERSION}"
WORKDIR /app
COPY apps/server/src ./
RUN echo '{"type":"module"}' > package.json && mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/v1/health || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "main.ts"]
