import Link from "next/link"

export default function PendingApprovalPage() {
  return (
    <div style={{ maxWidth: 520, margin: "64px auto", padding: 24, textAlign: "center" }}>
      <h1 style={{ fontFamily: "'Syne', sans-serif", marginBottom: 16 }}>Onay bekleniyor</h1>
      <p style={{ color: "var(--dim)", lineHeight: 1.7, marginBottom: 24 }}>
        Email doğrulandı. Hesabınız admin onayı bekliyor. Onaylandıktan sonra eBay paneline
        erişebilirsiniz.
      </p>
      <Link href="/app/login" style={{ color: "var(--accent)" }}>
        Sign in
      </Link>
    </div>
  )
}
