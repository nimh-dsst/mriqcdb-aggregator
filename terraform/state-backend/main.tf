terraform {
  required_version = ">= 1.0.0, < 2.0.0"

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

data "aws_caller_identity" "current" {}

locals {
  default_state_bucket_name = lower(
    "${var.project_name}-tofu-state-${data.aws_caller_identity.current.account_id}-${var.aws_region}",
  )
  state_bucket_name = var.state_bucket_name != null ? var.state_bucket_name : local.default_state_bucket_name
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Project     = var.project_name
      Purpose     = "tofu-state-backend"
    },
    var.tags,
  )
}

resource "aws_s3_bucket" "state" {
  bucket = local.state_bucket_name

  tags = merge(local.common_tags, { Name = local.state_bucket_name })
}

resource "aws_s3_bucket_public_access_block" "state" {
  bucket = aws_s3_bucket.state.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "state" {
  bucket = aws_s3_bucket.state.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "state" {
  bucket = aws_s3_bucket.state.id

  versioning_configuration {
    status = "Enabled"
  }
}
