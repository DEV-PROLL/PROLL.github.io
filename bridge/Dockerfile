FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY bridge/package.json ./bridge/
RUN npm install --workspaces --include-workspace-root --omit=optional || npm install
COPY bridge ./bridge
RUN npm run build -w bridge

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/bridge/node_modules ./bridge/node_modules
COPY --from=build /app/bridge/dist ./bridge/dist
COPY --from=build /app/bridge/package.json ./bridge/package.json
WORKDIR /app/bridge
EXPOSE 8080
CMD ["node", "dist/index.js"]
