# Multi-stage for a minimal runtime image. Coach-proxy has ZERO npm deps
# (pure Node http module) so npm ci is a no-op; we still run it for forward
# compat if a devDep is ever added.

FROM node:20-alpine AS base
WORKDIR /app

# Install deps first for a cacheable layer. With no deps today, this is
# essentially a noop but keeps the build reproducible.
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source
COPY server.js ./

# Run as non-root for security.
RUN addgroup -S app && adduser -S app -G app
USER app

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000

# node_modules may not exist if package has zero deps — that's fine.
CMD ["node", "server.js"]
