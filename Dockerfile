# Tide server + web app (one container). Nodes run separately (see node/).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY node/package.json node/
COPY web/package.json web/
RUN npm ci
COPY shared shared
COPY server server
COPY web web
RUN npm run build -w web

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3001 TIDE_DB=/data/tide.db WEB_DIST=/app/web/dist
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/package.json /app/tsconfig.base.json ./
COPY --from=build /app/shared shared
COPY --from=build /app/server server
COPY --from=build /app/web/dist web/dist
EXPOSE 3001
# Persist /data with a platform volume (Railway: add a Volume mounted at /data; compose: tide-data).
WORKDIR /app/server
CMD ["node", "--import", "tsx", "src/index.ts"]
