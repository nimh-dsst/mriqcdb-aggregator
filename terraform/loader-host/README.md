# MRIQC aggregator compose host

This stack creates a standalone EC2 host for running the MRIQC aggregator with
Docker Compose under systemd.

## What it creates

- One Debian 13 (Trixie) EC2 instance
- One dedicated security group with ports `22`, `80`, and `443`
- One dedicated IAM role and instance profile
- One persistent EBS volume mounted at `/data`
- One Elastic IP by default

## Runtime shape

Bootstrap now:

1. Installs Docker on the instance
2. Attaches and mounts the persistent EBS volume at `/data`
3. Clones this repository into `/opt/mriqc-aggregator`
4. Copies `.env.example` to `.env` and appends the production settings
5. Installs a systemd unit that runs `docker compose -f compose.yaml -f compose.prod.yaml up --build -d --wait`

The production stack is:

- `postgres` with its data persisted at `/data/postgres`
- `api` running Gunicorn inside the app container
- `nginx` publishing `80/443` and proxying to the app container

## Defaults

- Region: `us-east-1`
- VPC: the account default VPC unless you override it
- Public subnet: the first public subnet in that VPC unless you override it
- Instance type: `t3.xlarge`
- Root volume: `64 GiB`
- Data volume: `300 GiB`
- Repo URL: `https://github.com/nimh-dsst/mriqc-aggregator.git`
- Repo ref: `main`

## Usage

The Debian EC2 login user is `admin`.
SSH access is bootstrapped from every `*.pub` file under the repo `data/`
directory. `data/dsst2023.pub` is used as the EC2 launch key pair when present,
and all discovered keys are written into `/home/admin/.ssh/authorized_keys`.

```bash
AWS_PROFILE=osm_john tofu init
AWS_PROFILE=osm_john tofu apply
```

If you need to pin the network placement or restrict ingress:

```bash
AWS_PROFILE=osm_john tofu apply \
  -var='vpc_id=vpc-0123456789abcdef0' \
  -var='public_subnet_id=subnet-0123456789abcdef0' \
  -var='allowed_ingress_cidr_blocks=["203.0.113.10/32"]'
```

If the instance must clone from somewhere other than the public GitHub HTTPS
URL, override `repo_url` and optionally `repo_ref`.

## Notes

- OpenTofu now uses the default local backend unless you configure a remote one.
- The bootstrap path generates a self-signed certificate in `/data/nginx/certs`
  so `443` comes up immediately. Replace it with a real certificate when you
  have DNS and cert management in place.
