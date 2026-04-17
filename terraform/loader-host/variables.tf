variable "aws_region" {
  description = "AWS region for the host."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment tag applied to the host."
  type        = string
  default     = "prod"
}

variable "vpc_id" {
  description = "Optional VPC ID used for the host. Defaults to the account default VPC."
  type        = string
  default     = null
}

variable "public_subnet_id" {
  description = "Optional public subnet ID for the host. Defaults to the first public subnet in the selected VPC."
  type        = string
  default     = null
}

variable "instance_name" {
  description = "Unique prefix for resources created by this stack."
  type        = string
  default     = "mriqc-aggregator-host"
}

variable "instance_type" {
  description = "EC2 instance type for the compose host."
  type        = string
  default     = "t3.large"
}

variable "root_volume_size_gb" {
  description = "Root EBS size in GiB for the OS and container runtime."
  type        = number
  default     = 64
}

variable "data_volume_size_gb" {
  description = "Persistent EBS size in GiB mounted at /data for PostgreSQL and deployment assets."
  type        = number
  default     = 300
}

variable "allowed_ingress_cidr_blocks" {
  description = "CIDRs allowed to reach ports 22, 80, and 443."
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

variable "create_eip" {
  description = "Whether to allocate and associate an Elastic IP."
  type        = bool
  default     = true
}

variable "repo_url" {
  description = "Git URL cloned onto the host during bootstrap."
  type        = string
  default     = "https://github.com/nimh-dsst/mriqc-aggregator.git"
}

variable "repo_ref" {
  description = "Git branch cloned onto the host during bootstrap."
  type        = string
  default     = "main"
}

variable "managed_policy_arns" {
  description = "AWS managed policies attached to the host role."
  type        = list(string)
  default = [
    "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
  ]
}

variable "tags" {
  description = "Additional tags for all created resources."
  type        = map(string)
  default     = {}
}
