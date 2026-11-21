# Signin worker sidecar (jik.3): node:20-slim + Playwright + headless Chromium.
# Chromium profile data lives in /app/profiles — mount a volume to keep
# auth.qwen.ai sessions across restarts (silent renewal via reload).
FROM node:20-slim

ENV NODE_ENV=production \
    # Fixed browsers path: the build installs as root, the runtime runs as
    # USER app — the default ~/.cache location differs between the two and
    # the runtime would find no browser.
    PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
WORKDIR /app

# ca-certificates first so npm and the Playwright download both trust TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json ./
# --with-deps installs the distro libraries headless Chromium needs;
# a+rX because the runtime user differs from the install user.
RUN npm install --omit=dev \
    && npx playwright install --with-deps chromium \
    && chmod -R a+rX /opt/pw-browsers \
    && rm -rf /var/lib/apt/lists/* /tmp/*

COPY server.js ./
COPY lib/ ./lib/

RUN useradd --create-home --uid 10001 app \
    && mkdir -p /app/profiles \
    && chown -R app:app /app
USER app

ENV PORT=3100 \
    SIGNIN_DATA_DIR=/app/profiles
EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
