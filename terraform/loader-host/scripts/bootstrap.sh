#!/bin/bash
set -euxo pipefail

export DEBIAN_FRONTEND=noninteractive

DATA_VOLUME_ID="${data_volume_id}"
DATA_DEVICE_SERIAL="vol$(echo "$DATA_VOLUME_ID" | tr -d '-')"
REPO_DIR=/opt/mriqc-aggregator
REPO_URL="${repo_url}"
REPO_REF="${repo_ref}"
SSH_PUBLIC_KEYS=$(cat <<'EOF'
${ssh_public_keys}
EOF
)

apt-get update
apt-get install -y ca-certificates curl git gnupg jq openssl unzip awscli

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker
usermod -aG docker admin

install -d -m 0700 -o admin -g admin /home/admin/.ssh
printf '%s\n' "$SSH_PUBLIC_KEYS" > /home/admin/.ssh/authorized_keys
chown admin:admin /home/admin/.ssh/authorized_keys
chmod 0600 /home/admin/.ssh/authorized_keys

for attempt in $(seq 1 60); do
  DATA_DEVICE="$(lsblk -ndo PATH,SERIAL | awk -v serial="$DATA_DEVICE_SERIAL" '$2 == serial { print $1; exit }')"
  if [ -n "$DATA_DEVICE" ]; then
    break
  fi
  sleep 2
done

if [ -z "$${DATA_DEVICE:-}" ]; then
  echo "Timed out waiting for data volume $DATA_VOLUME_ID" >&2
  exit 1
fi

if ! blkid "$DATA_DEVICE" >/dev/null 2>&1; then
  mkfs.ext4 -F -L mriqc-data "$DATA_DEVICE"
fi

mkdir -p "$REPO_DIR" /data
if ! grep -q '^LABEL=mriqc-data /data ' /etc/fstab; then
  echo 'LABEL=mriqc-data /data ext4 defaults,nofail 0 2' >> /etc/fstab
fi
mount -a

mkdir -p /data/postgres /data/nginx/certs
chown -R admin:admin "$REPO_DIR" /data

if [ ! -d "$REPO_DIR/.git" ]; then
  rm -rf "$REPO_DIR"
  git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$REPO_DIR"
fi

if [ ! -f "$REPO_DIR/.env" ]; then
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
fi

if ! grep -q '^POSTGRES_DATA_DIR=' "$REPO_DIR/.env"; then
  echo 'POSTGRES_DATA_DIR=/data/postgres' >> "$REPO_DIR/.env"
fi

if ! grep -q '^APP_SERVER=' "$REPO_DIR/.env"; then
  echo 'APP_SERVER=gunicorn' >> "$REPO_DIR/.env"
fi

if ! grep -q '^GUNICORN_WORKERS=' "$REPO_DIR/.env"; then
  echo 'GUNICORN_WORKERS=3' >> "$REPO_DIR/.env"
fi

if ! grep -q '^GUNICORN_TIMEOUT=' "$REPO_DIR/.env"; then
  echo 'GUNICORN_TIMEOUT=120' >> "$REPO_DIR/.env"
fi

if [ ! -f /data/nginx/certs/fullchain.pem ] || [ ! -f /data/nginx/certs/privkey.pem ]; then
  openssl req \
    -x509 \
    -nodes \
    -days 3650 \
    -newkey rsa:2048 \
    -subj "/CN=mriqc-aggregator.local" \
    -keyout /data/nginx/certs/privkey.pem \
    -out /data/nginx/certs/fullchain.pem
fi

install -m 0644 "$REPO_DIR/deploy/systemd/mriqc-aggregator.service" /etc/systemd/system/mriqc-aggregator.service
systemctl daemon-reload
systemctl enable --now mriqc-aggregator.service
