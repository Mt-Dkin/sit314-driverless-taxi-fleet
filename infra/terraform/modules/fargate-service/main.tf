/**
 * Reusable module: one ECS Fargate service + its own Application Auto
 * Scaling target/policy. Instantiated once per microservice so that each
 * (Geofencing & Tracking, Dispatch & Billing, Alerting & Maintenance)
 * scales independently, per the "Solution Uniqueness" section of the
 * proposal.
 */

variable "name" {}
variable "cluster_id" {}
variable "container_port" { type = number }
variable "cpu" { type = number }
variable "memory" { type = number }
variable "execution_role_arn" {}
variable "task_role_arn" { default = null } # least-privilege runtime permissions (e.g. SQS access)
variable "subnets" { type = list(string) }
variable "vpc_id" {}
variable "desired_count" { type = number }
variable "min_capacity" { type = number }
variable "max_capacity" { type = number }
variable "cpu_target_value" { type = number }
variable "environment" {
  description = "Container environment variables, e.g. [{name=\"SQS_QUEUE_URL\", value=\"...\"}]"
  type        = list(object({ name = string, value = string }))
  default     = []
}

resource "aws_ecs_task_definition" "this" {
  family                   = "fleet-${var.name}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.cpu
  memory                   = var.memory
  execution_role_arn       = var.execution_role_arn
  task_role_arn            = var.task_role_arn

  container_definitions = jsonencode([{
    name      = var.name
    image     = "277870706905.dkr.ecr.us-east-1.amazonaws.com/fleet-${var.name}:latest" # replace after `docker push` to ECR
    portMappings = [{ containerPort = var.container_port, protocol = "tcp" }]
    environment = var.environment
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = "/ecs/fleet-${var.name}"
        "awslogs-region"        = "us-east-1"
        "awslogs-stream-prefix" = var.name
        "awslogs-create-group"  = "true"
      }
    }
  }])
}

resource "aws_security_group" "this" {
  name   = "fleet-${var.name}-sg"
  vpc_id = var.vpc_id

  ingress {
    from_port   = var.container_port
    to_port     = var.container_port
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"] # tighten to the ALB's SG in production
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_ecs_service" "this" {
  name            = var.name
  cluster         = var.cluster_id
  task_definition = aws_ecs_task_definition.this.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = var.subnets
    security_groups  = [aws_security_group.this.id]
    assign_public_ip = true
  }

  lifecycle {
    ignore_changes = [desired_count] # let Auto Scaling manage this after first apply
  }
}

# --- Auto Scaling: this is the "AWS Auto Scaling" box from Figure 1 ---
resource "aws_appautoscaling_target" "this" {
  max_capacity       = var.max_capacity
  min_capacity       = var.min_capacity
  resource_id        = "service/${element(split("/", var.cluster_id), 1)}/${aws_ecs_service.this.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu_scaling" {
  name               = "fleet-${var.name}-cpu-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = var.cpu_target_value
    scale_in_cooldown  = 60
    scale_out_cooldown = 60
  }
}
# --- Week 8: backlog-based scaling ---------------------------------------
# These services are I/O-bound queue consumers: under load, messages pile
# up in SQS long before CPU rises, so the CPU policy alone would rarely
# trigger. This second target-tracking policy scales on the queue backlog
# (messages waiting), which directly measures whether the service is
# keeping up. ECS takes the higher of the two policies' desired counts.
variable "queue_name" {
  description = "SQS queue this service consumes from (used for backlog scaling)"
  type        = string
}

variable "backlog_target" {
  description = "Target number of visible messages in the queue"
  type        = number
  default     = 100
}

resource "aws_appautoscaling_policy" "backlog_scaling" {
  name               = "fleet-${var.name}-backlog-scaling"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.this.resource_id
  scalable_dimension = aws_appautoscaling_target.this.scalable_dimension
  service_namespace  = aws_appautoscaling_target.this.service_namespace

  target_tracking_scaling_policy_configuration {
    customized_metric_specification {
      metric_name = "ApproximateNumberOfMessagesVisible"
      namespace   = "AWS/SQS"
      statistic   = "Average"

      dimensions {
        name  = "QueueName"
        value = var.queue_name
      }
    }
    target_value       = var.backlog_target
    scale_in_cooldown  = 60
    scale_out_cooldown = 30
  }
}
