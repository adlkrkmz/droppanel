\"use client\"

import { useEffect, useState } from \"react\"

type MonitorItemStatus = \"TRACKED\" | \"UNTRACKED\"

type MonitorItem = {
  sku:       string
  title:     string
  image:     string | null
  ebayPrice: number
  quantity:  number
  cost:      number | null
  margin:    number | null
  asin:      string | null
  status:    MonitorItemStatus
  poolId:    number | null
  stage:     string | null
}

type MonitorListingsResult = {
  store:        string
  total:        number
  tracked:      number
  untracked:    number
  simulationMode: boolean
  items:        MonitorItem[]
  generatedAt:  string
  currentPage:  number
  totalPages:   number
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? \"http://localhost:4000\"

export default function MonitorPage() {
  const [storeCode, setStoreCode] = useState(\"S1\")
  const [page, setPage] = useState(1)
  const [data, setData] = useState<MonitorListingsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function fetchPage(targetPage: number, store: string) {
    setLoading(true)
    setError(null)
    try {
      const url = new URL(\"/admin/monitor/listings\", API_BASE)
      url.searchParams.set(\"storeCode\", store)
      url.searchParams.set(\"page\", String(targetPage))
      url.searchParams.set(\"pageSize\", \"50\")
      const res = await fetch(url.toString())
      const body = await res.json()
      if (!res.ok) {
        throw new Error(body?.message ?? `HTTP ${res.status}`)
      }
      setData(body as MonitorListingsResult)
      setPage(targetPage)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchPage(1, storeCode)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handlePrev() {
    if (!data) return
    if (page <= 1) return
    fetchPage(page - 1, storeCode)
  }

  function handleNext() {
    if (!data) return
    if (page >= data.totalPages) return
    fetchPage(page + 1, storeCode)
  }

  return (
    <main className=\"p-4 space-y-3\">
      <div className=\"flex items-center justify-between\">
        <h1 className=\"text-lg font-semibold\">Monitor</h1>
        <div className=\"flex items-center gap-2\">
          <label className=\"text-sm\">Store</label>
          <select
            className=\"border rounded px-2 py-1 text-sm\"
            value={storeCode}
            onChange={e => {
              const store = e.target.value
              setStoreCode(store)
              fetchPage(1, store)
            }}
          >
            <option value=\"S1\">S1</option>
            <option value=\"S2\">S2</option>
            <option value=\"S3\">S3</option>
            <option value=\"S4\">S4</option>
          </select>
        </div>
      </div>

      {error && (
        <div className=\"text-sm text-red-600 bg-red-50 border border-red-200 rounded px-3 py-2\">
          {error}
        </div>
      )}

      <div className=\"flex items-center justify-between text-xs text-gray-600\">
        <div>
          {data ? (
            <>
              <span>Total: {data.total}</span>
              <span className=\"ml-3\">Tracked: {data.tracked}</span>
              <span className=\"ml-3\">Untracked: {data.untracked}</span>
            </>
          ) : (
            <span>Loading...</span>
          )}
        </div>
        {data && (
          <div>
            Page {data.currentPage} / {data.totalPages}
          </div>
        )}
      </div>

      <div className=\"border rounded overflow-hidden\">
        <table className=\"w-full text-xs\">
          <thead className=\"bg-gray-100\">
            <tr>
              <th className=\"px-2 py-1 text-left\">SKU</th>
              <th className=\"px-2 py-1 text-left\">Title</th>
              <th className=\"px-2 py-1 text-right\">Price</th>
              <th className=\"px-2 py-1 text-right\">Qty</th>
              <th className=\"px-2 py-1 text-right\">Cost</th>
              <th className=\"px-2 py-1 text-right\">Margin %</th>
              <th className=\"px-2 py-1 text-center\">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className=\"px-2 py-4 text-center text-gray-500\">
                  Loading...
                </td>
              </tr>
            )}
            {!loading && data && data.items.length === 0 && (
              <tr>
                <td colSpan={7} className=\"px-2 py-4 text-center text-gray-500\">
                  No items.
                </td>
              </tr>
            )}
            {!loading &&
              data &&
              data.items.map(item => (
                <tr key={item.sku} className=\"border-t\">
                  <td className=\"px-2 py-1 font-mono text-[11px]\">{item.sku}</td>
                  <td className=\"px-2 py-1 max-w-xs truncate\" title={item.title}>
                    {item.title}
                  </td>
                  <td className=\"px-2 py-1 text-right\">{item.ebayPrice.toFixed(2)}</td>
                  <td className=\"px-2 py-1 text-right\">{item.quantity}</td>
                  <td className=\"px-2 py-1 text-right\">
                    {item.cost !== null ? item.cost.toFixed(2) : \"-\"}
                  </td>
                  <td className=\"px-2 py-1 text-right\">
                    {item.margin !== null ? item.margin.toFixed(2) : \"-\"}
                  </td>
                  <td className=\"px-2 py-1 text-center\">
                    <span
                      className={
                        \"inline-flex px-2 py-0.5 rounded text-[10px] \" +
                        (item.status === \"TRACKED\"
                          ? \"bg-green-50 text-green-700 border border-green-200\"
                          : \"bg-gray-50 text-gray-600 border border-gray-200\")}>
                      {item.status}
                    </span>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className=\"flex items-center justify-between mt-2\">
        <button
          type=\"button\"
          className=\"px-3 py-1 rounded border text-xs disabled:opacity-40\"
          onClick={handlePrev}
          disabled={loading || !data || page <= 1}
        >
          Previous
        </button>
        {data && (
          <span className=\"text-xs text-gray-600\">
            Page {data.currentPage} of {data.totalPages}
          </span>
        )}
        <button
          type=\"button\"
          className=\"px-3 py-1 rounded border text-xs disabled:opacity-40\"
          onClick={handleNext}
          disabled={loading || !data || (data && page >= data.totalPages)}
        >
          Next
        </button>
      </div>
    </main>
  )
}

