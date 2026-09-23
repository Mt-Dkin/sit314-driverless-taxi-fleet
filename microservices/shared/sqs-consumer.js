/**
 * sqs-consumer.js
 *
 * Shared long-polling SQS consumer. When SQS_QUEUE_URL is set (i.e. when
 * running in AWS, wired up by Terraform), each microservice pulls its own
 * events directly off its own queue - this is what makes the architecture
 * genuinely event-driven rather than a disguised HTTP RPC call from
 * Node-RED. Locally (docker-compose, no SQS available), services fall
 * back to the HTTP endpoint only.
 */
const { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } = require("@aws-sdk/client-sqs");

function startSqsConsumer({ queueUrl, region, handler, logPrefix }) {
  if (!queueUrl) {
    console.log(`${logPrefix} SQS_QUEUE_URL not set - running in HTTP-only mode (local dev)`);
    return;
  }

  const client = new SQSClient({ region: region || "us-east-1" });
  console.log(`${logPrefix} starting SQS consumer on ${queueUrl}`);

  let stopped = false;

  async function pollLoop() {
    while (!stopped) {
      try {
        const { Messages } = await client.send(new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 20, // long polling - reduces empty-receive cost/noise
          VisibilityTimeout: 30,
        }));

        if (!Messages || Messages.length === 0) continue;

        for (const message of Messages) {
          try {
            const payload = JSON.parse(message.Body);
            await handler(payload);
            await client.send(new DeleteMessageCommand({
              QueueUrl: queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }));
          } catch (err) {
            // Leave un-deleted on failure - it becomes visible again after
            // VisibilityTimeout and is retried automatically.
            console.error(`${logPrefix} failed to process message, will retry:`, err.message);
          }
        }
      } catch (err) {
        console.error(`${logPrefix} SQS poll error:`, err.message);
        await new Promise((r) => setTimeout(r, 5000)); // back off before retrying
      }
    }
  }

  pollLoop();

  return () => { stopped = true; };
}

module.exports = { startSqsConsumer };
