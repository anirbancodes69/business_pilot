#!/bin/sh
# Runs once on first start of an empty data directory (docker-entrypoint-initdb.d), as the
# bootstrap superuser (POSTGRES_USER, which only exists for administration and is never used by the app).
# Role model (SECURITY.md section 4):
#   bp_owner  owns the database and schemas, runs migrations. No superuser, no BYPASSRLS.
#   bp_app    runtime role for api and worker. Owns nothing. No BYPASSRLS.
#   bp_system worker sweeper (P-15, ADR-0017). Can list tenant ids and status, nothing else. Logs in
#             with POSTGRES_SYSTEM_PASSWORD, used by the worker only.
# Table grants are made by the migrations, not here.
set -eu
psql -v ON_ERROR_STOP=1 \
  -v owner_user="$POSTGRES_OWNER_USER" -v owner_pw="$POSTGRES_OWNER_PASSWORD" \
  -v app_user="$POSTGRES_APP_USER" -v app_pw="$POSTGRES_APP_PASSWORD" \
  -v system_pw="$POSTGRES_SYSTEM_PASSWORD" \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
CREATE ROLE :"owner_user" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'owner_pw';
CREATE ROLE :"app_user" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'app_pw';
CREATE ROLE bp_system LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE PASSWORD :'system_pw';
-- The owner may assume bp_system (SET ROLE) so tests and operators can verify its limits. bp_app may not.
GRANT bp_system TO :"owner_user";
ALTER DATABASE :"DBNAME" OWNER TO :"owner_user";
REVOKE ALL ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO :"app_user", bp_system;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
