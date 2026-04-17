variable "aws_region" {
  description = "AWS region for the remote state bucket."
  type        = string
  default     = "us-east-1"
}

variable "environment" {
  description = "Environment tag applied to the remote state bucket."
  type        = string
  default     = "prod"
}

variable "project_name" {
  description = "Project prefix used in names and tags."
  type        = string
  default     = "mriqc-aggregator"
}

variable "state_bucket_name" {
  description = "Optional explicit S3 bucket name. Defaults to a deterministic account-scoped name."
  type        = string
  default     = null
}

variable "loader_host_state_key" {
  description = "Object key used by the loader-host stack state file."
  type        = string
  default     = "loader-host/terraform.tfstate"
}

variable "tags" {
  description = "Additional tags for created backend resources."
  type        = map(string)
  default     = {}
}
