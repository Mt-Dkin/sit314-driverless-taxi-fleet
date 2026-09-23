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
# IoT Core: edge ingestion endpoint for the taxi simulator (MQTT)
# ---------------------------------------------------------------------------
resource "aws_iot_topic_rule" "telemetry_to_sqs" {
  name        = "fleet_telemetry_to_sqs"
  description = "Routes vehicle telemetry from IoT Core into the Event Router / Queue (SQS)"
  enabled     = true
  sql         = "SELECT * FROM 'fleet/+/telemetry'"
  sql_version = "2016-03-23"

  sqs {
    queue_url  = aws_sqs_queue.event_queue.id
    role_arn   = aws_iam_role.iot_role.arn
    use_base64 = false
  }
}

resource "aws_iam_role" "iot_role" {
  name = "fleet-iot-to-sqs-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "iot.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "iot_sqs_policy" {
  name = "fleet-iot-sqs-send"
  role = aws_iam_role.iot_role.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["sqs:SendMessage"]
      Resource = aws_sqs_queue.event_queue.arn
    }]
  })
}

# ---------------------------------------------------------------------------
# SQS: Event Router / Queue, decouples ingestion from microservices
# ---------------------------------------------------------------------------
resource "aws_sqs_queue" "event_queue" {
  name                       = "fleet-event-queue"
  visibility_timeout_seconds = 30
  message_retention_seconds  = 3600
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

module "microservice" {
  for_each = var.microservices
  source   = "./modules/fargate-service"

  name               = each.key
  cluster_id         = aws_ecs_cluster.fleet_cluster.id
  container_port     = each.value.port
  cpu                = 256
  memory             = 512
  execution_role_arn = aws_iam_role.ecs_task_execution_role.arn
  subnets            = data.aws_subnets.default.ids
  vpc_id             = data.aws_vpc.default.id
  desired_count      = 1
  min_capacity       = 1
  max_capacity       = 5
  cpu_target_value   = 60
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
