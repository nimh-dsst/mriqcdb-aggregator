# MRIQC Aggregator Compose Host

This Terraform/OpenTofu stack creates a single EC2 host for running the full
MRIQC Aggregator production compose stack.

## What it creates

- One Debian 13 (Trixie) EC2 instance
- One security group allowing `22`, `80`, and `443`
- One IAM role and instance profile for the host
- One persistent EBS volume mounted at `/data`
- One Elastic IP by default
- Two AWS key pairs imported from tracked public keys in `keys/`

The EBS volume keeps the compose data across instance replacement. A full
`tofu destroy` will still delete that volume unless you snapshot or protect it
separately.

## What bootstrap does

On first boot, the instance:

1. Installs Docker and the Compose plugin
2. Mounts the persistent EBS volume at `/data`
3. Clones this repo into `/opt/mriqc-aggregator`
4. Creates `.env` from `.env.example` and appends production settings
5. Installs and starts the `mriqc-aggregator.service` systemd unit

That systemd unit runs:

```bash
docker compose -f compose.yaml -f compose.prod.yaml up --build -d --wait --remove-orphans
```

The runtime stack is:

- `postgres`, with data under `/data/postgres`
- `api`, running Gunicorn inside the app container
- `nginx`, publishing `80/443` and proxying to the API

Bootstrap also creates a self-signed certificate in `/data/nginx/certs` so
HTTPS comes up immediately. Replace it with a real certificate once DNS is in
place.

## Defaults

- Region: `us-east-1`
- Network: default VPC unless overridden
- Subnet: first public subnet in that VPC that supports the chosen instance type
- Instance type: `t3.small`
- Root volume: `64 GiB`
- Data volume: `300 GiB`
- Repo URL: `https://github.com/nimh-dsst/mriqc-aggregator.git`
- Repo ref: `main`

## SSH access

The EC2 login user is `admin`.

The Terraform stack imports exactly these two public keys:

- imported as an AWS key pair
- written to `/home/admin/.ssh/authorized_keys`

`keys/dsst2023.pub` is always used as the EC2 launch key pair.
`keys/dustin.pub` is also authorized on the host.

Only public keys are stored in the repository. Private keys must stay on
operator machines.

## Backend bootstrap

This stack now expects a remote `s3` backend so the host state is not left in a
local `terraform.tfstate` file.

Use the companion [`terraform/state-backend`](../state-backend/README.md) stack
to create a versioned S3 bucket for OpenTofu state, then copy
[`example.s3.tfbackend`](./example.s3.tfbackend) to a real
`*.s3.tfbackend` file that stays out of git:

```bash
cp example.s3.tfbackend prod.s3.tfbackend
```

Fill in the bucket name, then initialize with that backend config:

```bash
tofu init -backend-config=prod.s3.tfbackend
```

## Migrating existing local state

If you already applied this stack with the previous local backend, back up the
current state file before migration:

```bash
cp terraform.tfstate terraform.tfstate.local-backup
cp terraform.tfstate.backup terraform.tfstate.backup.local-backup
```

Then reinitialize with migration enabled:

```bash
tofu init -migrate-state -backend-config=prod.s3.tfbackend
```

OpenTofu will copy the existing local state into S3. Once the migration
completes, `terraform.tfstate` should no longer be the source of truth.

## Current DSST deployment

The current production host is managed in DSST AWS using a remote S3 backend.
The exact backend configuration and deployment-specific variable values are not
committed to this repository. Keep them in untracked files such as
`prod.s3.tfbackend` and `prod.tfvars`, or in secure deployment notes.

Remote state records the AWS objects already managed by this stack after an
apply. It does not replace normal input variables on a fresh workstation. An
operator still needs backend settings so OpenTofu can find the state, plus any
input variables required to select the intended VPC, subnet, and Elastic IP
behavior. If `vpc_id` and `public_subnet_id` are omitted, the module uses the
account default VPC and the first compatible public subnet it can find.

The production DNS names are `mriqcdb-aggregator.site` and
`www.mriqcdb-aggregator.site`; point them at the Elastic IP reported by the
remote state or `tofu output`.

The state backend already exists. Do not run `tofu init -migrate-state` for
normal production changes; use `-reconfigure` so a new workstation points at
the existing remote state.

From any host with OpenTofu and AWS credentials that can read and write the
DSST state backend and manage the EC2 resources:

```bash
cd terraform/loader-host

# Optional, if your AWS credentials are selected by profile.
export AWS_PROFILE=your-dsst-profile

tofu init -reconfigure -backend-config=prod.s3.tfbackend
tofu state list
tofu output instance_id
tofu output public_ip

tofu plan -var-file=prod.tfvars
```

Confirm the state outputs identify the current DSST host and Elastic IP before
running `plan` or `apply`. If state points at retired resources, stop and fix
the backend config; a wrong backend can make OpenTofu plan to recreate deleted
infrastructure.

If the plan is expected, apply with the same variables:

```bash
tofu apply -var-file=prod.tfvars
```

The production `prod.tfvars` should include only deployment-specific choices
that differ from module defaults. For example:

```hcl
create_eip = true
allowed_ingress_cidr_blocks = ["0.0.0.0/0"]

# Omit these to use the account default VPC/subnet.
# vpc_id           = "..."
# public_subnet_id = "..."
```

Using a separate `TF_DATA_DIR` is optional, but helpful if the same checkout has
been initialized against another backend:

```bash
export TF_DATA_DIR=/tmp/mriqc-aggregator-tofu-dsst
```

## How to use it

From this directory:

```bash
tofu init -backend-config=prod.s3.tfbackend
tofu plan -var-file=prod.tfvars
tofu apply -var-file=prod.tfvars
```

If you need to test a branch before merge, override `repo_ref`:

```bash
tofu apply -var='repo_ref=add-infra'
```

If you want to restrict inbound access:

```bash
tofu apply -var='allowed_ingress_cidr_blocks=["203.0.113.10/32"]'
```

If you do not want to use the default VPC/subnet:

```bash
tofu apply \
  -var='vpc_id=vpc-0123456789abcdef0' \
  -var='public_subnet_id=subnet-0123456789abcdef0'
```

## Useful outputs

After apply, Terraform prints:

- `public_ip`
- `http_url`
- `https_url`
- `ssh_command`
- `instance_id`
- `data_volume_id`

## Operations

- `https://<ip>/api/v1/health` should return `{"status":"ok"}`
- The root path `/` is expected to return `404`
- Bootstrap is first-boot-only. Later `user_data` edits are intentionally
  ignored for the existing host, so changing the bootstrap script does not
  churn the live instance.
- `tofu apply` can still replace the instance if other immutable settings
  change; the separate `/data` volume is meant to preserve compose data across
  that replacement
- The bootstrap configures SSH for public-key-only access and disables root
  login.
- `tofu destroy` removes the whole stack, including the persistent volume

## Notes

- This directory uses a partial `s3` backend configuration. Keep the real
  `*.s3.tfbackend` file out of git and pass it to `tofu init`.
- The current production deployment can be updated in place for size changes,
  such as `t3.large` to `t3.small`, without changing the Elastic IP.
