import Link from "next/link"

export default function EbayOnboardingPage() {
  return (
    <div style={{ maxWidth: 560, margin: "48px auto", padding: 24 }}>
      <h1 style={{ fontFamily: "'Syne', sans-serif", fontSize: "1.5rem", marginBottom: 12 }}>
        Add eBay Operations
      </h1>
      <p style={{ color: "var(--dim)", lineHeight: 1.6, marginBottom: 24 }}>
        eBay operations onboarding is not wired to billing yet. This placeholder confirms where
        product enrollment will live.
      </p>
      <Link
        href="/dashboard/ebay"
        style={{
          display: "inline-flex",
          padding: "10px 18px",
          borderRadius: 8,
          border: "1px solid #f43f5e",
          color: "#f43f5e",
          textDecoration: "none",
          fontWeight: 600,
          fontSize: 14,
        }}
      >
        Open eBay dashboard
      </Link>
    </div>
  )
}
