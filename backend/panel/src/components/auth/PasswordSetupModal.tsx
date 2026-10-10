'use client'

import { useState } from 'react'
import { postSetPassword } from '@/lib/userAuthClient'

/**
 * One-time ListJetGo password for Google-only accounts.
 * Same strength rules as /register (enforced by API).
 */
export default function PasswordSetupModal({
  email,
  onDone,
}: {
  email: string
  onDone: () => void
}) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    if (password !== confirm) {
      setError('Passwords do not match')
      return
    }
    setLoading(true)
    try {
      await postSetPassword(password, confirm)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not set password')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="lj-pw-setup-title"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: 'rgba(4, 8, 16, 0.72)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 420,
          background: 'rgba(14, 20, 34, 0.96)',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 16,
          padding: '24px 22px 20px',
          boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
          color: '#f4f7fb',
          fontFamily: "'DM Sans', system-ui, sans-serif",
        }}
      >
        <h2 id="lj-pw-setup-title" style={{ margin: '0 0 8px', fontFamily: "'Syne', sans-serif", fontSize: 20 }}>
          ListJetGo şifrenizi oluşturun
        </h2>
        <p style={{ margin: '0 0 18px', color: '#9aa6b8', fontSize: 13, lineHeight: 1.45 }}>
          Google ile giriş yaptınız (<strong style={{ color: '#e8eef8' }}>{email}</strong>).
          Aynı hesaba e-posta + şifre ile de girebilmek için bir ListJetGo şifresi belirleyin.
        </p>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#9aa6b8' }}>
            Şifre
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: '#9aa6b8' }}>
            Şifre tekrar
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              style={inputStyle}
            />
          </label>
          <p style={{ margin: 0, fontSize: 11, color: '#7a8699' }}>
            En az 8 karakter; en az bir harf ve bir rakam (normal kayıt ile aynı kurallar).
          </p>
          {error && <p style={{ margin: 0, color: '#f87171', fontSize: 13 }}>{error}</p>}
          <button
            type="submit"
            disabled={loading}
            style={{
              marginTop: 4,
              height: 44,
              border: 'none',
              borderRadius: 10,
              background: 'linear-gradient(90deg, #2d7ff9 0%, #34d399 100%)',
              color: '#041018',
              fontWeight: 700,
              fontSize: 14,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? 'Kaydediliyor…' : 'Şifreyi kaydet'}
          </button>
        </form>
      </div>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  height: 44,
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.12)',
  background: '#0a101c',
  color: '#fff',
  padding: '0 12px',
  fontSize: 14,
  outline: 'none',
}
