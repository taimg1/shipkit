import { listOrders } from "@/lib/orders"

/**
 * Rendered per request: it describes what the database holds right now, and a page prerendered
 * at build time would describe a database that was not running then.
 */
export const dynamic = "force-dynamic"

export default async function OrdersPage() {
  const orders = await listOrders()
  return (
    <main>
      <h1>Orders</h1>
      <ul>
        {orders.map((o) => (
          <li key={o.id} data-testid="order">
            {o.reference}
          </li>
        ))}
      </ul>
    </main>
  )
}
