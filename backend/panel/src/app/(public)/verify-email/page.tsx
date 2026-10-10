"use client"

import { Suspense, useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { verifyEmailToken } from "@/lib/userAuthClient"

function VerifyContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const [status, setStatus] = useState<"loading" | "ok" | "error">("loading")
  const [message, setMessage] = useState("")

  useEffect(() => {
    const token = searchParams.get("token")?.trim()
    if (!token) {
      setStatus("error")
      setMessage("Missing verification token")
      return
    }
    verifyEmailToken(token)
      .then(() => {
        setStatus("ok")
        setTimeout(() => router.push("/pending-approval"), 1500)
      })
      .catch((e) => {
        setStatus("error")
        setMessage(e instanceof Error ? e.message : "Verification failed")
      })
  }, [searchParams, router])

  return (
    <div style={{ maxWidth: 480, margin: "64px auto", padding: 24, textAlign: "center" }}>
      {status === "loading" && <p>Email doğrulanıyor…</p>}
      {status === "ok" && (
        <>
          <h1 style={{ fontFamily: "'Syne', sans-serif" }}>Email doğrulandı</h1>
          <p style={{ color: "var(--dim)" }}>Admin onay ekranına yönlendiriliyorsunuz…</p>
        </>
      )}
      {status === "error" && (
        <>
          <h1 style={{ fontFamily: "'Syne', sans-serif", color: "#f87171" }}>Doğrulama başarısız</h1>
          <p style={{ color: "var(--dim)" }}>{message}</p>
          <Link href="/register" style={{ color: "var(--accent)", marginTop: 16, display: "inline-block" }}>
            Register again
          </Link>
        </>
      )}
    </div>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<div style={{ textAlign: "center", marginTop: 64 }}>Yükleniyor…</div>}>
      <VerifyContent />
    </Suspense>
  )
}
