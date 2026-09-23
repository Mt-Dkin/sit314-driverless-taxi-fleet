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

variable "microservice_extra_env" {
  description = "Extra per-service environment variables, keyed by microservice name"
  type        = map(list(object({ name = string, value = string })))
  default = {
    "geofencing-tracking" = [
      { name = "MONGO_URL", value = "mongodb://REPLACE_WITH_ATLAS_OR_DOCUMENTDB_URI" },
      { name = "DB_NAME", value = "fleet" }
    ]
  }
}
