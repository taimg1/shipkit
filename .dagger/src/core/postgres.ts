import { dag, Service } from "@dagger.io/dagger"

export const PG_IMAGE = "postgres:17-alpine"
export const PG_USER = "postgres"
export const PG_PASSWORD = "postgres"

/**
 * A throwaway PostgreSQL service, started by the core and handed to whoever needs it.
 * The adapter never starts its own — see docs/multi-stack-plan.md §8.
 */
export function postgresService(db: string): Service {
  return dag
    .container()
    .from(PG_IMAGE)
    .withEnvVariable("POSTGRES_USER", PG_USER)
    .withEnvVariable("POSTGRES_PASSWORD", PG_PASSWORD)
    .withEnvVariable("POSTGRES_DB", db)
    .withExposedPort(5432)
    .asService({ useEntrypoint: true })
}

export const dsnFor = (host: string, db: string) =>
  `postgresql://${PG_USER}:${PG_PASSWORD}@${host}:5432/${db}`
