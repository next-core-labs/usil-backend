FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache curl
COPY package*.json ./
RUN npm install --omit=dev
# server.cjs plus the SPA build synced in via `npm run sync:web` before the image is built
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/public ./public
EXPOSE 3000
ENV PORT=3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "dist/server.cjs"]
