'use client'

import { useState } from 'react'
import Link from 'next/link'
import { postForgotPassword } from '@/lib/userAuthClient'

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setMessage('')
    setLoading(true)
    try {
      const result = await postForgotPassword(email)
      setMessage(result.message)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={wrap}>
      <h1 style={title}>Şifremi unuttum</h1>
      <p style={sub}>
        Hesabınıza bağlı e-posta adresini girin. Varsa sıfırlama bağlantısı oluşturulur.
      </p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={label}>
          E-posta
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={input}
          />
        </label>
        {error && <p style={{ color: '#f87171', margin: 0, fontSize: 13 }}>{error}</p>}
        {message && <p style={{ color: '#34d399', margin: 0, fontSize: 13 }}>{message}</p>}
        <button type="submit" disabled={loading} style={btn}>
          {loading ? 'Gönderiliyor…' : 'Sıfırlama bağlantısı iste'}
        </button>
      </form>
      <p style={{ marginTop: 18, fontSize: 13 }}>
        <Link href="/login" style={{ color: '#2d7ff9' }}>
          Girişe dön
        </Link>
      </p>
    </div>
  )
}

const wrap: React.CSSProperties = {
  maxWidth: 420,
  margin: '64px auto',
  padding: 24,
  color: 'var(--text, #e8eef8)',
}
const title: React.CSSProperties = { fontFamily: "'Syne', sans-serif", fontSize: 22, margin: '0 0 8px' }
const sub: React.CSSProperties = { color: 'var(--dim, #9aa6b8)', fontSize: 14, lineHeight: 1.45, margin: '0 0 18px' }
const label: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--dim, #9aa6b8)' }
const input: React.CSSProperties = {
  height: 44,
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.12)',
  background: '#0a101c',
  color: '#fff',
  padding: '0 12px',
  fontSize: 14,
}
const btn: React.CSSProperties = {
  height: 44,
  border: 'none',
  borderRadius: 10,
  background: 'linear-gradient(90deg, #2d7ff9 0%, #34d399 100%)',
  color: '#041018',
  fontWeight: 700,
  cursor: 'pointer',
}
