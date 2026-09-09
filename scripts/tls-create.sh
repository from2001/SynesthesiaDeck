#!/bin/sh
set -eu

# Generate a development certificate only after the operator has installed mkcert
# and deliberately established its local CA. This script never installs trust.
if ! command -v mkcert >/dev/null 2>&1; then
  echo 'mkcert is required. See docs/server.md for certificate and trust options.' >&2
  exit 1
fi
if [ "$#" -eq 0 ]; then
  echo 'Usage: sh scripts/tls-create.sh <Mac LAN DNS name> [<Mac LAN IP> ...]' >&2
  exit 1
fi
mkdir -p .certs
chmod 700 .certs
if [ -e .certs/show.pem ] || [ -e .certs/show-key.pem ]; then
  echo 'Existing certificate files found. Archive them deliberately before renewal; nothing was overwritten.' >&2
  exit 1
fi
umask 077
mkcert -cert-file .certs/show.pem -key-file .certs/show-key.pem "$@" localhost 127.0.0.1 ::1
chmod 600 .certs/show-key.pem
printf '%s\n' 'Created .certs/show.pem and .certs/show-key.pem. Configure TLS_CERT, TLS_KEY, and PUBLIC_ORIGIN in .env.'
printf '%s\n' 'Each browser/device must trust the issuing CA. A certificate warning bypass does not prove a secure WebXR context.'
