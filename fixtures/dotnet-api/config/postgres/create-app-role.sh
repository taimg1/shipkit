#!/bin/sh
# Runs once, when PostgreSQL initialises an empty data directory (docker-entrypoint-initdb.d).
#
# Creates `app`, the role the application connects as: rows in, rows out, no DDL. Tables are
# created by the migration bundle as $POSTGRES_USER, so the grants are default privileges on
# that role — every table a future migration creates is covered without anyone remembering.
#
# The password reaches psql as a variable and is quoted by psql itself (:'app_password'); it is
# never part of the SQL text and never parsed by this shell.
set -eu
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD must be set: the app role is not created without a password}"

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set app_password="$APP_DB_PASSWORD" --set owner="$POSTGRES_USER" <<'SQL'
CREATE ROLE app LOGIN PASSWORD :'app_password';
GRANT CONNECT ON DATABASE :"DBNAME" TO app;
GRANT USAGE ON SCHEMA public TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app;
ALTER DEFAULT PRIVILEGES FOR ROLE :"owner" IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app;
SQL
