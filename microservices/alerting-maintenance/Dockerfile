# Build context must be microservices/ (the parent dir), since this service
# requires ../shared/sqs-consumer.js. See docker-compose.yml and the
# per-service build instructions in the root README.
FROM node:20-alpine
WORKDIR /app
COPY alerting-maintenance/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY shared /shared
RUN cd /shared && npm install --omit=dev --no-audit --no-fund
COPY alerting-maintenance/ .
EXPOSE 3003
CMD ["node", "index.js"]
