'use client'

import { Suspense } from 'react'
import AuthExperience from '@/components/auth/AuthExperience'

function LoginFallback() {
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

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <AuthExperience initialMode="login" />
    </Suspense>
  )
}
