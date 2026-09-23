terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# ---------------------------------------------------------------------------
# AWS Academy Learner Labs note: the sandbox account does not allow creating
# new IAM roles/policies (iam:CreateRole etc. are denied by the lab's SCP).
# Everything below runs under the pre-existing LabRole instead of the
# per-service least-privilege roles a normal AWS account would use. This is
# a deliberate, documented trade-off for the lab environment - see the
# README and the final report's "appropriateness of solution" discussion
# for the production alternative (per-service roles, as originally
# scaffolded in git history).
# ---------------------------------------------------------------------------
data "aws_iam_role" "lab_role" {
  name = "LabRole"
}

# ---------------------------------------------------------------------------
# Networking (minimal - default VPC for Learner Labs simplicity)
# ---------------------------------------------------------------------------
data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

# ---------------------------------------------------------------------------
# IoT Core: secure device identity for the taxi simulator AND for Node-RED
# (Node-RED authenticates as an IoT "thing" using a certificate - X.509
# mutual TLS - and connects directly to the IoT Core MQTT endpoint to
# subscribe to fleet/+/telemetry. This is the "Demonstrate secure
# deployment" evidence: no username/password, cert-based auth only, and
# the IoT policy below is scoped to exactly the topics/actions needed.)
# ---------------------------------------------------------------------------
resource "aws_iot_thing" "node_red_ingestion" {
  name = "fleet-node-red-ingestion"
}

resource "aws_iot_certificate" "node_red_cert" {
  active = true
}

resource "aws_iot_thing_principal_attachment" "node_red_cert_attach" {
  thing     = aws_iot_thing.node_red_ingestion.name
  principal = aws_iot_certificate.node_red_cert.arn
}

resource "aws_iot_policy" "node_red_policy" {
  name = "fleet-node-red-ingestion-policy"
  # Least privilege: connect as this one client ID, subscribe/receive only
  # on the fleet telemetry topics - no publish rights, no wildcard topics.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["iot:Connect"]
        Resource = "arn:aws:iot:${var.aws_region}:*:client/fleet-node-red-ingestion"
      },
      {
        Effect   = "Allow"
        Action   = ["iot:Subscribe"]
        Resource = "arn:aws:iot:${var.aws_region}:*:topicfilter/fleet/+/telemetry"
      },
      {
        Effect   = "Allow"
        Action   = ["iot:Receive"]
        Resource = "arn:aws:iot:${var.aws_region}:*:topic/fleet/*/telemetry"
      }
    ]
  })
}

resource "aws_iot_policy_attachment" "node_red_policy_attach" {
  policy = aws_iot_policy.node_red_policy.name
  target = aws_iot_certificate.node_red_cert.arn
}

# Simulator gets its own, separate identity - publish-only, so a
# compromised simulator credential can never be used to *read* fleet data.
resource "aws_iot_thing" "simulator" {
  name = "fleet-taxi-simulator"
}

resource "aws_iot_certificate" "simulator_cert" {
  active = true
}

resource "aws_iot_thing_principal_attachment" "simulator_cert_attach" {
  thing     = aws_iot_thing.simulator.name
  principal = aws_iot_certificate.simulator_cert.arn
}

resource "aws_iot_policy" "simulator_policy" {
  name = "fleet-simulator-policy"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["iot:Connect"]
        Resource = "arn:aws:iot:${var.aws_region}:*:client/fleet-taxi-simulator-*"
      },
      {
        Effect   = "Allow"
        Action   = ["iot:Publish"]
        Resource = "arn:aws:iot:${var.aws_region}:*:topic/fleet/*/telemetry"
      }
    ]
  })
}

resource "aws_iot_policy_attachment" "simulator_policy_attach" {
  policy = aws_iot_policy.simulator_policy.name
  target = aws_iot_certificate.simulator_cert.arn
}

# ---------------------------------------------------------------------------
# SQS: one queue per microservice - this is the "Event Router / Queue" from
# Figure 1, split so each service only ever sees its own event category and
# only ever holds permissions on its own queue (least privilege, PR004).
# ---------------------------------------------------------------------------
resource "aws_sqs_queue" "microservice_queue" {
  for_each                   = var.microservices
  name                       = "fleet-${each.key}-queue"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 3600
}

# Node-RED and each microservice all run under LabRole in this environment
# (see note above). LabRole is broad by Learner Labs design; the SQS
# queue-per-service split still gives logical separation even though the
# IAM enforcement of "least privilege" isn't possible here.

# ---------------------------------------------------------------------------
# DynamoDB: Immutable Event History
# ---------------------------------------------------------------------------
resource "aws_dynamodb_table" "event_history" {
  name         = "fleet-event-history"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "vehicle_id"
  range_key    = "timestamp"

  attribute {
    name = "vehicle_id"
    type = "S"
  }
  attribute {
    name = "timestamp"
    type = "S"
  }
}

# ---------------------------------------------------------------------------
# ECS Fargate cluster + one service per microservice
# ---------------------------------------------------------------------------
resource "aws_ecs_cluster" "fleet_cluster" {
  name = "fleet-cluster"
}

# Each microservice's task definition/service, all running under LabRole.

# ---------------------------------------------------------------------------
# Node-RED: the ingestion/processing engine itself, running as its own
# Fargate task. Not auto-scaled (see PR003 - a single Node-RED instance is
# a known bottleneck candidate, documented as a limitation rather than
# solved in this iteration).
# ---------------------------------------------------------------------------
data "aws_iot_endpoint" "current" {
  endpoint_type = "iot:Data-ATS"
}

resource "aws_security_group" "node_red" {
  name   = "fleet-node-red-sg"
  vpc_id = data.aws_vpc.default.id

  ingress {
    from_port   = 1880
    to_port     = 1880
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"] # Node-RED editor/admin UI - restrict this in production
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_task_definition" "node_red" {
  family                   = "fleet-node-red"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = data.aws_iam_role.lab_role.arn
  task_role_arn            = data.aws_iam_role.lab_role.arn

  container_definitions = jsonencode([{
    name  = "node-red"
    image = "277870706905.dkr.ecr.us-east-1.amazonaws.com/fleet-node-red:latest" # build/push from node-red/aws/Dockerfile
    portMappings = [{ containerPort = 1880, protocol = "tcp" }]
    environment = [
      { name = "AWS_REGION", value = var.aws_region },
      { name = "GEOFENCING_QUEUE_URL", value = aws_sqs_queue.microservice_queue["geofencing-tracking"].id },
      { name = "DISPATCH_QUEUE_URL", value = aws_sqs_queue.microservice_queue["dispatch-billing"].id },
      { name = "ALERTING_QUEUE_URL", value = aws_sqs_queue.microservice_queue["alerting-maintenance"].id },
      { name = "IOT_ENDPOINT", value = data.aws_iot_endpoint.current.endpoint_address },
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/fleet-node-red"
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "node-red"
        "awslogs-create-group"  = "true"
      }
    }
  }])
}

resource "aws_ecs_service" "node_red" {
  name            = "node-red"
  cluster         = aws_ecs_cluster.fleet_cluster.id
  task_definition = aws_ecs_task_definition.node_red.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  network_configuration {
    subnets          = data.aws_subnets.default.ids
    security_groups  = [aws_security_group.node_red.id]
    assign_public_ip = true
  }
}

# ---------------------------------------------------------------------------
# ECR: image repos for each service + Node-RED. Build/push commands are in
# the README - do this before the first `terraform apply` that references
# these images, or apply once to create the repos, push, then apply again
# once you've swapped in the real image URIs.
# ---------------------------------------------------------------------------
resource "aws_ecr_repository" "microservice_repo" {
  for_each             = var.microservices
  name                 = "fleet-${each.key}"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

resource "aws_ecr_repository" "node_red_repo" {
  name                 = "fleet-node-red"
  image_tag_mutability = "MUTABLE"
  force_delete         = true
}

module "microservice" {
  for_each = var.microservices
  source   = "./modules/fargate-service"

  name               = each.key
  cluster_id         = aws_ecs_cluster.fleet_cluster.id
  container_port     = each.value.port
  cpu                = 256
  memory             = 512
  execution_role_arn = data.aws_iam_role.lab_role.arn
  task_role_arn      = data.aws_iam_role.lab_role.arn
  subnets            = data.aws_subnets.default.ids
  vpc_id             = data.aws_vpc.default.id
  desired_count      = 1
  min_capacity       = 1
  max_capacity       = 5
  cpu_target_value   = 60
  queue_name         = aws_sqs_queue.microservice_queue[each.key].name
  backlog_target     = 100
  environment = concat(
    [
      { name = "SQS_QUEUE_URL", value = aws_sqs_queue.microservice_queue[each.key].id },
      { name = "AWS_REGION", value = var.aws_region },
    ],
    lookup(var.microservice_extra_env, each.key, [])
  )
}

# ---------------------------------------------------------------------------
# CloudWatch: budget-conscious alarm example (ties into PR001 mitigation)
# ---------------------------------------------------------------------------
resource "aws_cloudwatch_metric_alarm" "high_cpu" {
  for_each            = var.microservices
  alarm_name          = "fleet-${each.key}-high-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 70
  alarm_description   = "Triggers scale-out for ${each.key} when CPU > 70% for 2 consecutive periods"
  dimensions = {
    ClusterName = aws_ecs_cluster.fleet_cluster.name
    ServiceName = each.key
  }
}
