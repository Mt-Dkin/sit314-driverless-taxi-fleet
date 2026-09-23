/**
 * settings.js (AWS-deployed Node-RED instance)
 *
 * Injects the AWS SDK SQS client + the per-microservice queue URLs into
 * Function node global context via `functionGlobalContext`. This is the
 * standard, safe way to give Function nodes access to an npm module
 * without enabling the (riskier) "allow Function nodes to load external
 * modules" editor setting - the module is only usable via global.get(),
 * never require()'d directly inside the sandboxed function.
 *
 * Queue URLs are read from environment variables set on the ECS task
 * definition by Terraform (see infra/terraform/main.tf).
 */
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");

module.exports = {
  flowFile: "flows.aws.json",
  uiPort: process.env.PORT || 1880,

  functionGlobalContext: {
    SQSClient,
    SendMessageCommand,
    queueUrls: {
      geofencing: process.env.GEOFENCING_QUEUE_URL,
      dispatch: process.env.DISPATCH_QUEUE_URL,
      alerting: process.env.ALERTING_QUEUE_URL,
    },
    awsRegion: process.env.AWS_REGION || "us-east-1",
  },
};
