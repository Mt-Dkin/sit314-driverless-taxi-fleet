# Cloud-Native Autonomous Fleet Management for a Driver-less Taxi System

SIT314/SIT729 Distinction Task — Mackenzie Turley (s224876985)

This repo implements the architecture from the Project Proposal (v1.0) and
Project Update (v2.0): a Node.js edge simulator publishing MQTT telemetry,
a Node-RED filtering/aggregation pipeline, and three independently
scalable Node.js microservices on AWS ECS Fargate.

## Repo layout

```
simulator/            Node.js taxi fleet telemetry simulator + local MQTT
                       broker (dev/test stand-in for AWS IoT Core) + a
                       worker-threads load-test script
node-red/local/        Local dev flow (flows.json): filtering, aggregation,
                       transform, event flagging, routes to microservices
                       over HTTP - used with docker-compose, no AWS needed
node-red/aws/           AWS-deployed flow (flows.aws.json), custom
                       Dockerfile + settings.js: identical processing
                       logic, but publishes to each microservice's own SQS
                       queue instead of calling them over HTTP - this is
                       the genuinely event-driven production path
microservices/         geofencing-tracking, dispatch-billing,
                       alerting-maintenance - each a standalone Express
                       service with BOTH an HTTP endpoint (local dev) and
                       an SQS long-poll consumer (used automatically when
                       SQS_QUEUE_URL is set, i.e. when deployed to AWS)
microservices/shared/  Shared SQS consumer helper used by all three
                       services
infra/terraform/       AWS infrastructure as code: IoT Core things/certs/
                       policies (mutual-TLS device identity for the
                       simulator and for Node-RED, each least-privilege),
                       per-service SQS queues + least-privilege IAM task
                       roles, ECS Fargate cluster + per-service Auto
                       Scaling, CloudWatch alarms
docker-compose.yml     Runs the entire local-dev stack (Mongo, broker,
                       Node-RED local flow, all three services in HTTP
                       mode, simulator)
```

## Architecture note: why two Node-RED flows / two service modes

The project proposal specifies SQS decoupling Node-RED from the
microservices (an event-driven architecture, one of the six distinction
requirements). Testing that against a real SQS queue locally isn't
practical without an AWS account, so:

- **Local dev** (`docker-compose up`): Node-RED (`node-red/local/flows.json`)
  calls each microservice over plain HTTP. Fully working and tested in
  this environment - good for verifying the filtering/aggregation logic
  and each microservice's business logic in isolation.
- **AWS deployment** (`node-red/aws/`): Node-RED publishes to SQS via the
  AWS SDK; each microservice's `SQS_QUEUE_URL` environment variable
  (injected by Terraform) switches it into consumer mode automatically.
  This is the version that satisfies the "event-based microservice
  architecture" requirement and is what should be running when you
  capture your Week 7-8 evidence.

Both flows share identical filtering/aggregation/transformation logic -
only the final "how do I hand this off to the microservices" step
differs.

## What has been verified locally (Weeks 1-7)

- [x] Simulator connects to an MQTT broker and publishes valid telemetry
      matching the Data Design schema (`vehicle_id`, `ride_id`, `timestamp`,
      `coordinates`, `speed`, `battery_percentage`, `passenger_status`,
      `status_flags`)
- [x] Local broker receives and logs live throughput
- [x] Local Node-RED flow JSON validated and ready to import (filtering,
      temporal/spatial aggregation, event flagging, routing all implemented
      as function nodes per the proposal's "Fundamental Data Preparation"
      section)
- [x] AWS Node-RED flow JSON validated, all Function node bodies checked
      for JS syntax errors (cannot be run end-to-end without a real SQS
      queue/IoT Core endpoint)
- [x] All three microservices run independently in HTTP mode, expose
      `/health`, and correctly process a real request each (geofence
      check, fare calculation on ride completion, CRITICAL alert on
      SUSPECTED_CRASH) - retested after the SQS refactor, all still pass
- [x] Local worker-threads stress test: 100 simulated vehicles sustained
      ~71 msg/s through the local broker (see `simulator/stress-test.js`)
- [x] Least-privilege IAM designed: simulator can only publish, Node-RED
      can only subscribe to telemetry + send to SQS (never receive), each
      microservice can only receive/delete from its own queue

## What still needs to happen in your AWS account (Week 7-8)

This environment has no AWS credentials, so the Terraform in
`infra/terraform/` has **not** been applied. To deploy for real:

1. `cd infra/terraform && terraform init && terraform plan` against your
   AWS Learner Labs credentials.
2. Build + push each microservice image to ECR (build context is
   `./microservices`, e.g.
   `docker build -f microservices/geofencing-tracking/Dockerfile -t <ecr-uri> microservices`),
   then replace the `PLACEHOLDER_ECR_IMAGE_URI` in
   `modules/fargate-service/main.tf` with the real image URI for each
   service. Do the same for `node-red/aws/Dockerfile`.
3. `terraform apply`.
4. **Learner Labs caveat:** the Academy/Learner Labs role is often
   restricted from creating new IAM roles/policies or IoT certificates.
   If any `aws_iam_role` / `aws_iot_certificate` resources fail, check
   whether a pre-existing lab role (e.g. `LabRole`) needs to be
   referenced instead of creating new ones.
5. Download the generated IoT certificate/private key (Terraform outputs
   these - see `terraform output`) and set the Node-RED and simulator
   environment/secrets accordingly so they can complete the mutual-TLS
   handshake against IoT Core.
6. Re-run the stress test against the deployed stack for your scalability
   evidence.
7. Screenshot: ECS service task count scaling up under load, the
   CloudWatch CPU alarm firing, and SQS queue depth during a burst - this
   is your Week 7-8 evidence.

## Running everything locally right now

```bash
docker compose up --build
```

Then open Node-RED at `http://localhost:1880` - it loads
`node-red/local/flows.json` automatically.
