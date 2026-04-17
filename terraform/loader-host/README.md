# MRIQC Aggregator Compose Host

This Terraform/OpenTofu stack creates a single EC2 host for running the full
MRIQC Aggregator production compose stack.

## What it creates

- One Debian 13 (Trixie) EC2 instance
- One security group allowing `22`, `80`, and `443`
- One IAM role and instance profile for the host
- One persistent EBS volume mounted at `/data`
- One Elastic IP by default
- One AWS key pair per `data/*.pub` file in this repo

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
- Instance type: `t3.large`
- Root volume: `64 GiB`
- Data volume: `300 GiB`
- Repo URL: `https://github.com/nimh-dsst/mriqc-aggregator.git`
- Repo ref: `main`

## SSH access

The EC2 login user is `admin`.

Every `data/*.pub` key in this repo is:

- imported as an AWS key pair
- written to `/home/admin/.ssh/authorized_keys`

If `data/dsst2023.pub` exists, it is used as the EC2 launch key pair.
Otherwise the first discovered key is used.

## How to use it

From this directory:

```bash
tofu init
tofu plan
tofu apply
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
- `tofu apply` can replace the instance if immutable settings change; the
  separate `/data` volume is meant to preserve compose data across that
  replacement
- `tofu destroy` removes the whole stack, including the persistent volume

## Notes

- This directory uses the local Terraform/OpenTofu backend unless you configure
  a remote backend yourself.
- The current production deployment can be updated in place for size changes,
  such as `t3.xlarge` to `t3.large`, without changing the Elastic IP.
