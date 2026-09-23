output "iot_endpoint" {
  value = data.aws_iot_endpoint.current.endpoint_address
}

output "node_red_certificate_pem" {
  value     = aws_iot_certificate.node_red_cert.certificate_pem
  sensitive = true
}

output "node_red_private_key" {
  value     = aws_iot_certificate.node_red_cert.private_key
  sensitive = true
}

output "simulator_certificate_pem" {
  value     = aws_iot_certificate.simulator_cert.certificate_pem
  sensitive = true
}

output "simulator_private_key" {
  value     = aws_iot_certificate.simulator_cert.private_key
  sensitive = true
}

output "microservice_queue_urls" {
  value = { for k, q in aws_sqs_queue.microservice_queue : k => q.id }
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.fleet_cluster.name
}

output "ecr_repository_urls" {
  value = merge(
    { for k, r in aws_ecr_repository.microservice_repo : k => r.repository_url },
    { "node-red" = aws_ecr_repository.node_red_repo.repository_url }
  )
}
