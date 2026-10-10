'use client'

import { Suspense, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { postResetPassword } from '@/lib/userAuthClient'

function ResetPasswordForm() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')?.trim() ?? ''
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (!token) {
      setError('Missing reset token')
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    setLoading(true)
    try {
      await postResetPassword(token, password, confirm)
      setDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Reset failed')
    } finally {
      setLoading(false)
    }
  }

  if (!token) {
    return (
      <div style={wrap}>
        <h1 style={title}>Geçersiz bağlantı</h1>
        <p style={sub}>Sıfırlama bağlantısı eksik veya bozuk.</p>
        <Link href="/forgot-password" style={{ color: '#2d7ff9' }}>
          Yeni bağlantı iste
        </Link>
      </div>
    )
  }

  if (done) {
    return (
      <div style={wrap}>
        <h1 style={title}>Şifre güncellendi</h1>
        <p style={sub}>Yeni şifrenizle giriş yapabilirsiniz.</p>
        <Link href="/login" style={{ color: '#2d7ff9' }}>
          Giriş Yap
        </Link>
      </div>
    )
  }

  return (
    <div style={wrap}>
      <h1 style={title}>Yeni şifre belirle</h1>
      <p style={sub}>En az 8 karakter; en az bir harf ve bir rakam (normal kayıt ile aynı kurallar).</p>
      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <label style={label}>
          Yeni şifre
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={input}
          />
        </label>
        <label style={label}>
          Şifre tekrar
          <input
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            style={input}
          />
        </label>
        {error && <p style={{ color: '#f87171', margin: 0, fontSize: 13 }}>{error}</p>}
        <button type="submit" disabled={loading} style={btn}>
          {loading ? 'Kaydediliyor…' : 'Şifreyi kaydet'}
        </button>
      </form>
    </div>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<div style={{ textAlign: 'center', marginTop: 64 }}>Yükleniyor…</div>}>
      <ResetPasswordForm />
    </Suspense>
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
