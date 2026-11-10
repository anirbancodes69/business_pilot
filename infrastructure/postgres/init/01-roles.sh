#!/bin/sh
# Runs once on first start of an empty data directory (docker-entrypoint-initdb.d).
# Creates the runtime role. It owns nothing and cannot bypass RLS.
# Milestone 2 defines the full role model (bp_owner, bp_app, bp_system), grants and RLS policies.
# NOTE: in this image POSTGRES_USER (bp_owner) is a superuser. Local development only.
set -eu
psql -v ON_ERROR_STOP=1 -v app_user="$POSTGRES_APP_USER" -v app_pw="$POSTGRES_APP_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE :"app_user" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_pw';
GRANT CONNECT ON DATABASE :"DBNAME" TO :"app_user";
SQL
