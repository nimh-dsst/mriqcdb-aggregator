output "state_bucket_name" {
  description = "Name of the S3 bucket that stores OpenTofu state."
  value       = aws_s3_bucket.state.id
}

output "state_bucket_arn" {
  description = "ARN of the S3 bucket that stores OpenTofu state."
  value       = aws_s3_bucket.state.arn
}

output "loader_host_backend_config" {
  description = "Backend config contents for terraform/loader-host."
  value       = <<-EOT
bucket       = "${aws_s3_bucket.state.id}"
key          = "${var.loader_host_state_key}"
region       = "${var.aws_region}"
use_lockfile = true
encrypt      = true
EOT
}
