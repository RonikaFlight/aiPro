# ========================================================================== #
# ProofPilot — Hardened Production Dockerfile                                  #
#                                                                            #
# Multi-stage build: deps → builder → runner                                 #
# - Non-root user (proofpilot)                                                #
# - Pinned base images                                                       #
# - No devDependencies in runtime                                            #
# - Health check via /api/v1/health                                           #
# - STOPSIGNAL SIGTERM for graceful shutdown                                 #
#                                                                            #
# Read-only filesystem usage:                                                #
#   docker run --read-only \
#     --tmpfs /tmp:rw,noexec,nosuid,size=100m \
#     -e DATABASE_URL=file:/data/proofpilot.db \
#     -v proofpilot-db:/data \
#     -p 3000:3000 \
#     proofpilot:latest                                                      #
# ========================================================================== #

# -------------------------------------------------------------------------- #
# Stage 1: deps — install ALL dependencies (including devDependencies)       #
# -------------------------------------------------------------------------- #
FROM oven/bun:1.2.4-alpine AS deps

# Install build-time system dependencies required by native modules (argon2, sharp)
RUN apk add --no-cache python3 make g++ sqlite-libs

WORKDIR /app

# Copy lockfile first for better layer caching
COPY bun.lock package.json ./

# Install all dependencies (dev + prod) — needed for `next build`
RUN bun install --frozen-lockfile

# -------------------------------------------------------------------------- #
# Stage 2: builder — produce Next.js standalone output                        #
# -------------------------------------------------------------------------- #
FROM oven/bun:1.2.4-alpine AS builder

RUN apk add --no-cache python3 make g++ sqlite-libs

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Copy production node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy all source code
COPY . .

# Generate Prisma client (required before build so imports resolve)
RUN bunx prisma generate

# Build Next.js standalone output
# The build script copies .next/static and public into the standalone dir
RUN bun run build

# -------------------------------------------------------------------------- #
# Stage 3: runner — minimal production image                                   #
# -------------------------------------------------------------------------- #
FROM oven/bun:1.2.4-alpine AS runner

# Security: install only runtime essentials + wget (for HEALTHCHECK)
RUN apk add --no-cache wget sqlite-libs ca-certificates tini

# Create non-root user/group
RUN addgroup -S proofpilot && \
    adduser -S -G proofpilot -H -D proofpilot

# Create app directory owned by the non-root user
WORKDIR /app
RUN chown proofpilot:proofpilot /app

# Copy standalone output from builder
COPY --from=builder --chown=proofpilot:proofpilot /app/.next/standalone ./

# Copy static assets and public directory (already placed by build script)
COPY --from=builder --chown=proofpilot:proofpilot /app/.next/standalone/.next ./.next
COPY --from=builder --chown=proofpilot:proofpilot /app/.next/standalone/public ./public

# Copy Prisma schema for runtime migrations
COPY --from=builder --chown=proofpilot:proofpilot /app/prisma ./prisma

# Copy production node_modules (standalone may need some for Prisma, argon2, sharp, etc.)
COPY --from=deps --chown=proofpilot:proofpilot /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=deps --chown=proofpilot:proofpilot /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=deps --chown=proofpilot:proofpilot /app/node_modules/argon2 ./node_modules/argon2
COPY --from=deps --chown=proofpilot:proofpilot /app/node_modules/sharp ./node_modules/sharp

# Ensure the non-root user owns everything
RUN chown -R proofpilot:proofpilot /app

# Switch to non-root user
USER proofpilot

# Environment
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME="0.0.0.0"

# Expose the application port
EXPOSE 3000

# Signal handling: use tini as PID 1 to properly forward SIGTERM/SIGINT
# This prevents zombie processes and ensures graceful shutdown
ENTRYPOINT ["/sbin/tini", "--"]

# Start the Next.js standalone server
CMD ["bun", "server.js"]

# Health check: probe the lightweight /api/v1/health endpoint
# --start-period gives the app 10s to boot before health checks count
# --retries allows 3 consecutive failures before marking unhealthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/v1/health || exit 1

# Graceful shutdown signal
STOPSIGNAL SIGTERM
