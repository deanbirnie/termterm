# Build from the repository root:  docker build -f apps/server/Dockerfile -t termterm-server .
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/server apps/server
RUN npm install --no-save typescript@7 @types/node@22 && npx tsc -p apps/server/tsconfig.build.json

FROM node:22-alpine
ENV NODE_ENV=production TERMTERM_DB=/data/termterm.db PORT=8787
WORKDIR /app
COPY --from=build /src/apps/server/dist ./
RUN echo '{"type":"module"}' > package.json && mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "main.js"]
