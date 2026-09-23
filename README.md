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
node-red/flows.json    Importable Node-RED flow: validation, filtering,
                       temporal + spatial aggregation, format transform,
                       event flagging, routing to the three microservices
microservices/         geofencing-tracking, dispatch-billing,
                       alerting-maintenance - each a standalone Express
                       service + Dockerfile
infra/terraform/       AWS infrastructure as code: IoT Core rule, SQS,
                       DynamoDB, ECS Fargate cluster + per-service Auto
                       Scaling, CloudWatch alarms
docker-compose.yml     Runs the entire stack locally (Mongo, broker,
                       Node-RED, all three services, simulator)
```

## What has been verified locally (Weeks 1-6)

- [x] Simulator connects to an MQTT broker and publishes valid telemetry
      matching the Data Design schema (`vehicle_id`, `ride_id`, `timestamp`,
      `coordinates`, `speed`, `battery_percentage`, `passenger_status`,
      `status_flags`)
- [x] Local broker receives and logs live throughput
- [x] Node-RED flow JSON validated and ready to import (filtering,
      temporal/spatial aggregation, event flagging, routing all implemented
      as function nodes per the proposal's "Fundamental Data Preparation"
      section)
- [x] All three microservices run independently, expose `/health`, and
      correctly process a real request each (geofence check, fare
      calculation on ride completion, CRITICAL alert on SUSPECTED_CRASH)
- [x] Local worker-threads stress test: 100 simulated vehicles sustained
      ~71 msg/s through the local broker (see `simulator/stress-test.js`)

## What still needs to happen in your AWS account (Week 7-8)

This environment has no AWS credentials, so the Terraform in
`infra/terraform/` has **not** been applied. To deploy for real:

1. `cd infra/terraform && terraform init && terraform plan` against your
   AWS Learner Labs credentials.
2. Build + push each microservice image to ECR, then replace the
   `PLACEHOLDER_ECR_IMAGE_URI` in `modules/fargate-service/main.tf` with
   the real image URI for each service.
3. `terraform apply`.
4. **Learner Labs caveat:** the Academy/Learner Labs role is often
   restricted from creating new IAM roles/policies. If `aws_iam_role`
   resources fail, check whether a pre-existing lab role (e.g.
   `LabRole`) needs to be referenced instead of creating new ones.
5. Point the simulator's `MQTT_URL` at your AWS IoT Core endpoint (use
   the IoT Core certs, not username/password) and re-run the stress test
   against the deployed stack for your scalability evidence.
6. Screenshot: ECS service task count scaling up under load, the
   CloudWatch CPU alarm firing, and the SQS queue depth during a burst -
   this is your Week 7-8 evidence.

## Running everything locally right now

```bash
docker compose up --build
```

Then open Node-RED at `http://localhost:1880` and import
`node-red/flows.json` (Menu -> Import -> paste/select file).
