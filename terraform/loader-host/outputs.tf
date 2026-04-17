output "instance_id" {
  description = "EC2 instance ID for the host."
  value       = aws_instance.host.id
}

output "data_volume_id" {
  description = "Persistent EBS volume ID mounted at /data."
  value       = aws_ebs_volume.data.id
}

output "primary_ssh_key_name" {
  description = "AWS key pair name associated with the instance launch."
  value       = local.primary_ssh_key_name != null ? aws_key_pair.host[local.primary_ssh_key_name].key_name : null
}

output "public_ip" {
  description = "Elastic IP if enabled, otherwise the instance public IP."
  value       = var.create_eip ? aws_eip.host[0].public_ip : aws_instance.host.public_ip
}

output "public_dns" {
  description = "Public DNS name for the host."
  value       = aws_instance.host.public_dns
}

output "security_group_id" {
  description = "Security group ID attached to the host."
  value       = aws_security_group.host.id
}

output "instance_profile_name" {
  description = "IAM instance profile name attached to the host."
  value       = aws_iam_instance_profile.host.name
}

output "http_url" {
  description = "HTTP endpoint for the nginx reverse proxy."
  value       = "http://${var.create_eip ? aws_eip.host[0].public_ip : aws_instance.host.public_ip}"
}

output "https_url" {
  description = "HTTPS endpoint for the nginx reverse proxy."
  value       = "https://${var.create_eip ? aws_eip.host[0].public_ip : aws_instance.host.public_ip}"
}

output "ssh_command" {
  description = "SSH command for the Debian host."
  value       = "ssh admin@${var.create_eip ? aws_eip.host[0].public_ip : aws_instance.host.public_ip}"
}

output "ssm_start_session_command" {
  description = "CLI command for opening an SSM shell."
  value       = "aws ssm start-session --target ${aws_instance.host.id}"
}
