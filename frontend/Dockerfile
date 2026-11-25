FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY public ./public
COPY src ./src
COPY index.html vite.config.js ./
ARG WAHA_SESSION
ENV VITE_WAHA_SESSION=$WAHA_SESSION
ENV VITE_USE_MOCK=false
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /app/dist /srv
