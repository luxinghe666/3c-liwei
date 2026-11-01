FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node dist ./dist
RUN mkdir -p /app/data /app/backups && chown node:node /app/data /app/backups
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4318 DB_PATH=/app/data/finance.sqlite
EXPOSE 4318
CMD ["node", "server/start.mjs"]
