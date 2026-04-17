# MRIQC Aggregator OpenTofu State Backend

This stack bootstraps the S3 bucket used for the `terraform/loader-host`
OpenTofu state.

It intentionally keeps its own state local by default, because the bucket must
exist before `loader-host` can migrate to a remote backend.

## What it creates

- One private S3 bucket for OpenTofu state
- Bucket versioning for state recovery
- Default AES256 server-side encryption
- Public access blocks on the bucket

The default bucket name is:

```text
mriqc-aggregator-tofu-state-<aws-account-id>-<aws-region>
```

Override `state_bucket_name` if you need a different globally unique name.

## How to use it

From this directory:

```bash
tofu init
tofu apply
```

After apply, render a backend config file for `loader-host`:

```bash
tofu output -raw loader_host_backend_config > ../loader-host/prod.s3.tfbackend
```

Then migrate the existing `loader-host` state:

```bash
cd ../loader-host
cp terraform.tfstate terraform.tfstate.local-backup
cp terraform.tfstate.backup terraform.tfstate.backup.local-backup
tofu init -migrate-state -backend-config=prod.s3.tfbackend
```

Once the migration completes, future `tofu plan` and `tofu apply` runs for
`loader-host` should keep using `-backend-config=prod.s3.tfbackend` only during
`init`.
