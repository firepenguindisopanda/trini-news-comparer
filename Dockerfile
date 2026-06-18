# =============================================================================
# Stage 1: Build
# =============================================================================
FROM node:22-alpine AS builder

ARG VITE_BASE_URL=/
ARG VITE_API_BASE_URL=
ARG VITE_PUSHER_KEY=
ARG VITE_PUSHER_CLUSTER=us2

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN VITE_BASE_URL=${VITE_BASE_URL} \
    VITE_API_BASE_URL=${VITE_API_BASE_URL} \
    VITE_PUSHER_KEY=${VITE_PUSHER_KEY} \
    VITE_PUSHER_CLUSTER=${VITE_PUSHER_CLUSTER} \
    npm run build

# =============================================================================
# Stage 2: Runtime
# =============================================================================
FROM node:22-alpine AS runtime

WORKDIR /app

# Install only production dependencies (smaller image)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built artifacts from builder
COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/cache/health || exit 1

CMD ["node", "dist/server.cjs"]
