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

locals {
  common_tags = merge(
    {
      Environment = var.environment
      ManagedBy   = "terraform"
      Project     = "mriqc-aggregator"
      Purpose     = "compose-host"
    },
    var.tags,
  )

  selected_vpc_id     = var.vpc_id != null ? var.vpc_id : data.aws_vpc.default[0].id
  selected_subnet_id  = var.public_subnet_id != null ? var.public_subnet_id : sort(data.aws_subnets.public[0].ids)[0]
  data_device_name    = "/dev/sdf"
  web_ports           = [80, 443]
  allowed_cidr_blocks = toset(var.allowed_ingress_cidr_blocks)
  ssh_key_files       = sort(fileset("${path.module}/../..", "data/*.pub"))
  ssh_public_keys = {
    for relpath in local.ssh_key_files :
    trimsuffix(basename(relpath), ".pub") => trimspace(file("${path.module}/../../${relpath}"))
  }
  primary_ssh_key_name = contains(keys(local.ssh_public_keys), "dsst2023") ? "dsst2023" : sort(keys(local.ssh_public_keys))[0]
}

data "aws_vpc" "default" {
  count   = var.vpc_id == null ? 1 : 0
  default = true
}

data "aws_subnets" "public" {
  count = var.public_subnet_id == null ? 1 : 0

  filter {
    name   = "vpc-id"
    values = [local.selected_vpc_id]
  }

  filter {
    name   = "map-public-ip-on-launch"
    values = ["true"]
  }
}

data "aws_subnet" "selected" {
  id = local.selected_subnet_id
}

data "aws_ami" "debian_trixie" {
  most_recent = true
  owners      = ["136693071363"]

  filter {
    name   = "name"
    values = ["debian-13-amd64-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

data "aws_iam_policy_document" "ec2_assume_role" {
  statement {
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }

    actions = ["sts:AssumeRole"]
  }
}

resource "aws_security_group" "host" {
  name_prefix = "${var.instance_name}-"
  description = "Security group for the MRIQC aggregator host"
  vpc_id      = local.selected_vpc_id

  dynamic "ingress" {
    for_each = local.allowed_cidr_blocks

    content {
      description = "SSH access"
      from_port   = 22
      to_port     = 22
      protocol    = "tcp"
      cidr_blocks = [ingress.value]
    }
  }

  dynamic "ingress" {
    for_each = toset(local.web_ports)

    content {
      description = "Web access"
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = var.allowed_ingress_cidr_blocks
    }
  }

  egress {
    description = "Allow outbound traffic"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = merge(local.common_tags, { Name = "${var.instance_name}-sg" })
}

resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.selected.availability_zone
  size              = var.data_volume_size_gb
  type              = "gp3"
  encrypted         = true

  tags = merge(local.common_tags, { Name = "${var.instance_name}-data" })
}

resource "aws_key_pair" "host" {
  for_each = local.ssh_public_keys

  key_name   = "${var.instance_name}-${each.key}"
  public_key = each.value

  tags = merge(local.common_tags, { Name = "${var.instance_name}-${each.key}" })
}

resource "aws_iam_role" "host" {
  name               = "${var.instance_name}-role"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume_role.json

  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "managed" {
  for_each = toset(var.managed_policy_arns)

  role       = aws_iam_role.host.name
  policy_arn = each.value
}

resource "aws_iam_instance_profile" "host" {
  name = "${var.instance_name}-profile"
  role = aws_iam_role.host.name

  tags = local.common_tags
}

resource "aws_instance" "host" {
  ami                         = data.aws_ami.debian_trixie.id
  instance_type               = var.instance_type
  subnet_id                   = data.aws_subnet.selected.id
  vpc_security_group_ids      = [aws_security_group.host.id]
  iam_instance_profile        = aws_iam_instance_profile.host.name
  key_name                    = aws_key_pair.host[local.primary_ssh_key_name].key_name
  associate_public_ip_address = true
  user_data = templatefile("${path.module}/scripts/bootstrap.sh", {
    data_volume_id  = aws_ebs_volume.data.id
    repo_ref        = var.repo_ref
    repo_url        = var.repo_url
    ssh_public_keys = join("\n", [for key_name in sort(keys(local.ssh_public_keys)) : local.ssh_public_keys[key_name]])
  })
  user_data_replace_on_change = true

  root_block_device {
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
    encrypted             = true
    delete_on_termination = true
  }

  tags = merge(local.common_tags, { Name = var.instance_name })
}

resource "aws_volume_attachment" "data" {
  device_name = local.data_device_name
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.host.id
}

resource "aws_eip" "host" {
  count = var.create_eip ? 1 : 0

  domain = "vpc"

  tags = merge(local.common_tags, { Name = "${var.instance_name}-eip" })
}

resource "aws_eip_association" "host" {
  count = var.create_eip ? 1 : 0

  instance_id   = aws_instance.host.id
  allocation_id = aws_eip.host[0].id
}
