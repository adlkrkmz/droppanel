'use client'

import { Suspense } from 'react'
import AuthExperience from '@/components/auth/AuthExperience'

function RegisterFallback() {
  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#070a12',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#9aa6b8',
        fontFamily: 'sans-serif',
      }}
    >
      …
    </div>
  )
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<RegisterFallback />}>
      <AuthExperience initialMode="register" />
    </Suspense>
  )
}
