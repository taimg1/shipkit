import { Pool } from "pg"

/**
 * The one thing in this fixture that needs a server the pipeline has to start for it.
 *
 * A real client site reads from an API or a database that is not in the repository. Without
 * it the page still renders — with nothing on it — which is the failure the e2e stage exists
 * to catch: 200, no error, and a page a customer would call broken.
 */
export interface Order {
  id: number
  reference: string
}

let pool: Pool | null = null

function connection(): Pool {
  // Lazily, so `next build` can trace this module without a database anywhere near it.
  if (!pool) pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 })
  return pool
}

export async function listOrders(): Promise<Order[]> {
  const { rows } = await connection().query<Order>("select id, reference from orders order by id")
  return rows
}
