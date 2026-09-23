FROM nodered/node-red:4.1.15-20

WORKDIR /usr/src/node-red
USER root
RUN npm install --no-audit --no-fund @aws-sdk/client-sqs@^3.687.0
USER node-red

COPY --chown=node-red:node-red settings.js /data/settings.js
COPY --chown=node-red:node-red flows.aws.json /data/flows.aws.json
COPY --chown=node-red:node-red certs/node-red-cert.pem /data/certs/node-red-cert.pem
COPY --chown=node-red:node-red certs/node-red-private.key /data/certs/node-red-private.key
COPY --chown=node-red:node-red certs/AmazonRootCA1.pem /data/certs/AmazonRootCA1.pem

EXPOSE 1880
# The base image entrypoint passes a flow-file argument on the command
# line (derived from this env var), which takes precedence over the
# flowFile setting in settings.js - without this, it silently loads the
# default empty flows.json instead of our flows.aws.json.
ENV FLOWS=flows.aws.json
