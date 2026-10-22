FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY lib ./lib
COPY routes ./routes
COPY views ./views
COPY public ./public
COPY server.js ./

VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
