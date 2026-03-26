FROM node:20-slim

WORKDIR /app

# Install deps first (layer cache)
COPY package.json package-lock.json* ./
RUN npm ci --production

# Copy source
COPY src/ src/
COPY docs/ docs/
COPY config/ config/

# Runtime data directory (mount a volume here)
RUN mkdir -p data

ENV NODE_ENV=production
ENV PORT=3200

EXPOSE 3200

CMD ["node", "src/index.js"]
