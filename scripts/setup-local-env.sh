#!/bin/sh
# Creates .env from .env.example and replaces secret placeholders with random local values.
# Refuses to touch an existing .env.
set -eu
cd "$(dirname "$0")/.."
if [ -e .env ]; then
  echo ".env already exists; not modifying it."
  exit 0
fi
while IFS= read -r line; do
  case "$line" in
    LOCAL_KEK_BASE64=*) echo "LOCAL_KEK_BASE64=$(openssl rand -base64 32)" ;;
    *'<set-locally>'* | *'<generate-locally>'*) echo "${line%%=*}=$(openssl rand -hex 16)" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < .env.example > .env
chmod 600 .env
echo "Created .env with random local secrets."
