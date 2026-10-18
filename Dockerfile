#
# blitz.cloud keep-alive agent as a deployable container.
#
# The image serves HTTP on $PORT (required: blitz.cloud only marks an app
# Online once it answers on its port) and runs the browser visits in the
# background.
#
# Use the official Playwright image so Chromium and all system libraries are
# already present. This avoids package-manager network failures in cloud
# builders while keeping the browser version pinned with the base image.
FROM mcr.microsoft.com/playwright:v1.56.1-noble@sha256:f1e7e01021efd65dd1a2c56064be399f3e4de00fd021ac561325f2bfbb2b837a

# Docker and gVisor commonly disable Chromium user namespaces. Keep the
# process non-root and rely on the container boundary when this is enabled.

ENV NODE_ENV=production \
    CHROME_PATH=/ms-playwright/chromium-1194/chrome-linux/chrome \
    CHROME_NO_SANDBOX=true \
    PORT=8080 \
    BIND_HOST=0.0.0.0 \
    HOME=/tmp \
    LOG_DIR=/app/logs

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY keepalive.mjs ./
COPY public ./public
RUN mkdir -p /app/logs /app/data && chown -R pwuser:pwuser /app

# Let blitz detect the writable state directories as persistent volumes.
VOLUME ["/app/data", "/app/logs"]

USER pwuser
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "keepalive.mjs"]
