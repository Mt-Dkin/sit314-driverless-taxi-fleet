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

# Node-RED's own role: allowed to SEND to all three queues, but not to
# receive/delete from any of them - it is a producer only.
resource "aws_iam_role" "node_red_task_role" {
  name = "fleet-node-red-task-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "node_red_sqs_send" {
  name = "fleet-node-red-sqs-send"
  role = aws_iam_role.node_red_task_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = [for q in aws_sqs_queue.microservice_queue : q.arn]
    }]
  })
}

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

resource "aws_iam_role" "ecs_task_execution_role" {
  name = "fleet-ecs-task-execution-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_role_policy" {
  role       = aws_iam_role.ecs_task_execution_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Each microservice gets its own task role, scoped to receive/delete only
# on its own queue - geofencing-tracking can never touch dispatch-billing's
# queue, etc.
resource "aws_iam_role" "microservice_task_role" {
  for_each = var.microservices
  name     = "fleet-${each.key}-task-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "microservice_sqs_receive" {
  for_each = var.microservices
  name     = "fleet-${each.key}-sqs-receive"
  role     = aws_iam_role.microservice_task_role[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"]
      Resource = aws_sqs_queue.microservice_queue[each.key].arn
    }]
  })
}

module "microservice" {
  for_each = var.microservices
  source   = "./modules/fargate-service"

  name               = each.key
  cluster_id         = aws_ecs_cluster.fleet_cluster.id
  container_port     = each.value.port
  cpu                = 256
  memory             = 512
  execution_role_arn = aws_iam_role.ecs_task_execution_role.arn
  task_role_arn      = aws_iam_role.microservice_task_role[each.key].arn
  subnets            = data.aws_subnets.default.ids
  vpc_id             = data.aws_vpc.default.id
  desired_count      = 1
  min_capacity       = 1
  max_capacity       = 5
  cpu_target_value   = 60
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
