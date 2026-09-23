# Custom Node-RED image for the AWS-deployed ingestion pipeline.
# The stock nodered/node-red image doesn't include @aws-sdk/client-sqs, and
# Function nodes can't require() arbitrary npm modules unless those modules
# live alongside the Node-RED install - so we install it there directly and
# expose it via functionGlobalContext in settings.js (see settings.js).
FROM nodered/node-red:3.1

WORKDIR /usr/src/node-red
USER root
RUN npm install --no-audit --no-fund @aws-sdk/client-sqs@^3.687.0
USER node-red

COPY --chown=node-red:node-red settings.js /data/settings.js
COPY --chown=node-red:node-red flows.aws.json /data/flows.aws.json

EXPOSE 1880
