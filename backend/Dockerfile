FROM node:22-bookworm
WORKDIR /app
COPY package.json package-lock.json ./
RUN apt-get update && apt-get install -y python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN npm_config_build_from_source=true npm_config_nodedir=/usr/local npm ci --omit=dev
RUN node -e "require('sqlite3')"
COPY src ./src
USER node
CMD ["node", "src/server.js"]
