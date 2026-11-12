# Build context: repository root. Used for both the api and worker processes (different command).
FROM node:24-slim AS build
ENV CI=true
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter @businesspilot/api...
COPY apps/api apps/api
RUN pnpm --filter @businesspilot/api build \
 && pnpm --filter @businesspilot/api deploy --legacy --prod /out \
 && cp -r apps/api/dist /out/dist

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3001 3002
CMD ["node", "dist/main.js"]
