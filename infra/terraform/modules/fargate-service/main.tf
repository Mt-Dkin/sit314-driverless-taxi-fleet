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
    image     = "PLACEHOLDER_ECR_IMAGE_URI" # replace after `docker push` to ECR
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
  resource_id        = "service/${var.cluster_id}/${aws_ecs_service.this.name}"
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
