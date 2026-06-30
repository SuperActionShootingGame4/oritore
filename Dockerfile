# ---- Build stage ----
FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---- Runtime stage ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/frontend/dist ./frontend/dist
# Published packs are written here (data/packs.json) — mount a persistent volume on /app/data
RUN mkdir -p /app/data
EXPOSE 3000
CMD ["node", "dist/server.js"]
