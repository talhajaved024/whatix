FROM node:22-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm_config_build_from_source=true npm_config_nodedir=/usr/local npm ci --omit=dev
RUN node -e "require('sqlite3')"
COPY src ./src
# The server runs as `node`, and COPY keeps the files' permissions. The VPS
# updater checks the code out with umask 077 (owner-only), which once left
# server.js unreadable and the API in a restart loop: make the code readable
# whatever the checkout's permissions were.
RUN chmod -R a+rX /app/src
USER node
CMD ["node", "src/server.js"]
