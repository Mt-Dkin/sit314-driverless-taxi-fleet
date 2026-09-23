# Build context must be microservices/ (the parent dir), since this service
# requires ../shared/sqs-consumer.js. See docker-compose.yml and the
# per-service build instructions in the root README.
FROM node:20-alpine
WORKDIR /app
COPY geofencing-tracking/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY shared /shared
RUN cd /shared && npm install --omit=dev --no-audit --no-fund
COPY geofencing-tracking/ .
EXPOSE 3001
CMD ["node", "index.js"]
