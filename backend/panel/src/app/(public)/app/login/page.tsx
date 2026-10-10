'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/** Legacy user login path → unified /login experience */
export default function AppLoginRedirectPage() {
  const router = useRouter()
  useEffect(() => {
    router.replace('/login')
  }, [router])
  return (
    <div
      style={{
        minHeight: '40vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--dim)',
      }}
    >
      …
    </div>
  )
}
