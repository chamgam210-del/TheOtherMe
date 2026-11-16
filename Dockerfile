# Server image for one-click hosting (Render blueprint in render.yaml; also works on Fly, Railway, any Docker host).
FROM node:22-slim
WORKDIR /app
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 NODE_ENV=development
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY desktop/package.json desktop/package.json
RUN npm ci --workspace server --include-workspace-root
COPY server server
RUN npm run build -w server && npm prune --omit=dev --workspace server
ENV NODE_ENV=production DATA_DIR=/data
VOLUME /data
EXPOSE 10000
CMD ["node", "server/dist/index.js"]
