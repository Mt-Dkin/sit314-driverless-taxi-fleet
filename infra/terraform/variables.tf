variable "aws_region" {
  description = "AWS region to deploy into (Learner Labs is typically us-east-1)"
  type        = string
  default     = "us-east-1"
}

variable "microservices" {
  description = "The three event-driven microservices deployed to ECS Fargate"
  type = map(object({
    port = number
  }))
  default = {
    "geofencing-tracking" = { port = 3001 }
    "dispatch-billing"    = { port = 3002 }
    "alerting-maintenance" = { port = 3003 }
  }
}
