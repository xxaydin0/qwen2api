# Node + Chromium runtime for executing the real baxia SDK inside the container to obtain tokens
# Uses Debian instead of Alpine because headless Chromium has poor dependency/compatibility support on Alpine
FROM node:24-bookworm-slim

# Install ffmpeg + yt-dlp + Chromium (including system libraries required for headless mode)
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        yt-dlp \
        chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chromium --version || true

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY . .

# Running as non-root in containers is safer; Chrome requires --no-sandbox (already included in baxia-token.js)
ENV NODE_ENV=production
ENV PORT=7860
# Point to the Debian Chromium executable
ENV CHROME_PATH=/usr/bin/chromium

EXPOSE 7860

CMD ["node", "index.js"]