#
# blitz.cloud keep-alive agent as a deployable container.
#
# The image serves HTTP on $PORT (required: blitz.cloud only marks an app
# Online once it answers on its port) and runs the browser visits in the
# background.
FROM node:22-alpine

# System Chromium: no browser download at build time, smaller image.
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont \
    && rm -rf /var/cache/apk/*

ENV NODE_ENV=production \
    CHROME_PATH=/usr/bin/chromium-browser \
    PORT=8080 \
    BIND_HOST=0.0.0.0 \
    HOME=/tmp \
    LOG_DIR=/app/logs

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY keepalive.mjs ./
COPY public ./public
RUN mkdir -p /app/logs /app/data && chown -R node:node /app

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "keepalive.mjs"]

