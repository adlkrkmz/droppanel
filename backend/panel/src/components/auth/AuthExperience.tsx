'use client'

import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { postPanelLogin, postPanelRegister } from '@/lib/authClient'
import { postUserLogin } from '@/lib/userAuthClient'
import GoogleSignInButton from '@/components/app/GoogleSignInButton'
import './auth-experience.css'

export type AuthMode = 'login' | 'register'
export type AuthLang = 'tr' | 'en'

const COPY = {
  tr: {
    brandSub: 'eBay Operasyon Platformu',
    headlineBefore: 'Ticaretinizi hızlandırın.',
    headlineAccent: 'Dünyaya açılın.',
    features: [
      'Akıllı Otomasyon',
      'Stock Guard',
      'Sipariş Takibi',
      'Gerçek Zamanlı Operasyon Takibi',
      'Ürün Araştırma',
      'Güvenli Altyapı',
    ],
    foot: 'ListJetGo ile stok, fiyat ve sipariş operasyonlarınızı tek panelden yönetin.',
    tabLogin: 'Giriş Yap',
    tabRegister: 'Hesap Oluştur',
    greetLogin: 'Tekrar hoş geldiniz!',
    greetLoginSub: 'Devam etmek için giriş yapın.',
    greetRegister: 'Hesabınızı oluşturun',
    greetRegisterSub: 'ListJetGo eBay operasyon hesabı açın.',
    email: 'E-posta adresi',
    password: 'Şifre',
    confirm: 'Şifre tekrar',
    forgot: 'Şifremi unuttum?',
    submitLogin: 'Giriş Yap',
    submitRegister: 'Hesap Oluştur',
    loadingLogin: 'Giriş yapılıyor…',
    loadingRegister: 'Kayıt oluşturuluyor…',
    or: 'veya',
    mismatch: 'Şifreler eşleşmiyor',
    registerOkTitle: 'Kayıt alındı',
    registerOkBody: 'eBay operasyon hesabınız yönetici onayını bekliyor.',
    goLogin: 'Girişe dön',
    floatATitle: 'Stock Guard',
    floatASub: 'Kaynak doğrulama aktif',
    floatBTitle: 'Sipariş takibi',
    floatBSub: 'Operasyon paneli',
    floatC: 'Stok koruması',
    floatD: 'Fiyat senkronu',
  },
  en: {
    brandSub: 'eBay Operations Platform',
    headlineBefore: 'Accelerate your commerce.',
    headlineAccent: 'Go global.',
    features: [
      'Smart Automation',
      'Stock Guard',
      'Order Tracking',
      'Real-time Operations Tracking',
      'Product Research',
      'Secure Infrastructure',
    ],
    foot: 'Manage stock, pricing, and order operations from one ListJetGo panel.',
    tabLogin: 'Sign In',
    tabRegister: 'Create Account',
    greetLogin: 'Welcome back!',
    greetLoginSub: 'Sign in to continue.',
    greetRegister: 'Create your account',
    greetRegisterSub: 'Open your ListJetGo eBay operations account.',
    email: 'Email address',
    password: 'Password',
    confirm: 'Confirm password',
    forgot: 'Forgot password?',
    submitLogin: 'Sign In',
    submitRegister: 'Create Account',
    loadingLogin: 'Signing in…',
    loadingRegister: 'Creating account…',
    or: 'or',
    mismatch: 'Passwords do not match',
    registerOkTitle: 'Registration received',
    registerOkBody: 'Your eBay operations account is waiting for admin approval.',
    goLogin: 'Back to sign in',
    floatATitle: 'Stock Guard',
    floatASub: 'Source verification on',
    floatBTitle: 'Order tracking',
    floatBSub: 'Operations panel',
    floatC: 'Stock protection',
    floatD: 'Price sync',
  },
} as const

function PlaneMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3.5 11.5 20 4.5l-5.2 15.2-3.1-5.4-5.2.2 4.3-4.8-7.3 1.8Z"
        fill="#041018"
        stroke="#041018"
        strokeWidth="0.6"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function IconMail() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
      <path d="m5 7.5 7 5.5 7-5.5" />
    </svg>
  )
}

function IconLock() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V8a4 4 0 0 1 8 0v2" />
    </svg>
  )
}

function IconEye({ off }: { off?: boolean }) {
  if (off) {
    return (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 3l18 18M10.5 10.7a2.5 2.5 0 0 0 3.3 3.3M9.2 5.6A10.5 10.5 0 0 1 12 5c5.2 0 9.2 3.8 10.5 7-0.5 1.2-1.3 2.5-2.4 3.6M6.1 6.2C4.5 7.4 3.4 8.9 2.5 12c1.3 3.2 5.3 7 10.5 7 1.4 0 2.7-.3 3.9-.7" />
      </svg>
    )
  }
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M2.5 12C3.8 8.8 7.8 5 12 5s8.2 3.8 9.5 7c-1.3 3.2-5.3 7-9.5 7s-8.2-3.8-9.5-7Z" />
      <circle cx="12" cy="12" r="2.8" />
    </svg>
  )
}

const FEAT_ICONS = [
  // rocket
  <path key="r" d="M14 4c2.5 1 4.5 3.5 5 6.5-2.5.6-4.7-.3-6.2-1.8L9.5 12l-1.8-1.8L11 6.8C12.5 5.3 13.5 4.3 14 4Zm-7 9.5 1.8 1.8L6.5 18.5 4.5 16.5 7 13.5Zm1.5 5.5c.4 1.4 1.4 2.4 2.8 2.8l1.2-2.2-1.8-1.8-2.2 1.2Z" />,
  // shield
  <path key="s" d="M12 3.5 19 6.5v5c0 4.4-2.9 7.8-7 9.5-4.1-1.7-7-5.1-7-9.5v-5l7-3Zm0 2.1L7 7.3v4.2c0 3.2 2 5.8 5 7.2 3-1.4 5-4 5-7.2V7.3l-5-1.7Z" />,
  // package
  <path key="p" d="M12 3.2 20 7.5v9L12 20.8 4 16.5v-9L12 3.2Zm0 2.2L7.2 8 12 10.6 16.8 8 12 5.4ZM6 9.7v5.6l5 2.7v-5.6L6 9.7Zm12 0-5 2.7v5.6l5-2.7V9.7Z" />,
  // pulse
  <path key="u" d="M3 12h4l2-5 3 10 2-5h7" stroke="currentColor" strokeWidth="1.8" fill="none" />,
  // search
  <path key="e" d="M10.5 4.5a6 6 0 1 1 0 12 6 6 0 0 1 0-12Zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm6.2 9.1 3.2 3.2-1.4 1.4-3.2-3.2 1.4-1.4Z" />,
  // lock
  <path key="l" d="M8 10V8a4 4 0 0 1 8 0v2h1.5A1.5 1.5 0 0 1 19 11.5v7A1.5 1.5 0 0 1 17.5 20h-11A1.5 1.5 0 0 1 5 18.5v-7A1.5 1.5 0 0 1 6.5 10H8Zm2 0h4V8a2 2 0 1 0-4 0v2Z" />,
]

function WorldMap() {
  return (
    <svg viewBox="0 0 800 480" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <defs>
        <radialGradient id="ljGlow" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#2d7ff9" stopOpacity="0.35" />
          <stop offset="55%" stopColor="#34d399" stopOpacity="0.12" />
          <stop offset="100%" stopColor="transparent" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="ljArc" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#2d7ff9" />
          <stop offset="100%" stopColor="#34d399" />
        </linearGradient>
      </defs>
      <rect width="800" height="480" fill="url(#ljGlow)" />
      {Array.from({ length: 18 }).map((_, row) =>
        Array.from({ length: 32 }).map((__, col) => {
          const x = 30 + col * 24
          const y = 40 + row * 22
          const dx = (x - 400) / 400
          const dy = (y - 240) / 240
          if (dx * dx + dy * dy > 0.92) return null
          const hide = (row + col) % 5 === 0
          if (hide) return null
          return <circle key={`${row}-${col}`} cx={x} cy={y} r="1.4" fill="rgba(180,200,230,0.28)" />
        })
      )}
      <path
        d="M120 280 C220 180, 320 160, 420 210 S620 250, 700 160"
        fill="none"
        stroke="url(#ljArc)"
        strokeWidth="2"
        strokeOpacity="0.75"
      />
      <path
        d="M160 340 C280 300, 360 250, 480 270 S640 320, 720 250"
        fill="none"
        stroke="url(#ljArc)"
        strokeWidth="1.5"
        strokeOpacity="0.45"
      />
      <circle cx="420" cy="210" r="5" fill="#2d7ff9" />
      <circle cx="700" cy="160" r="4" fill="#34d399" />
      <circle cx="160" cy="340" r="4" fill="#2d7ff9" />
    </svg>
  )
}

export default function AuthExperience({ initialMode }: { initialMode: AuthMode }) {
  const router = useRouter()
  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [lang, setLang] = useState<AuthLang>('tr')
  const t = COPY[lang]
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [showPw, setShowPw] = useState(false)
  const [error, setError] = useState('')
  const [hint, setHint] = useState('')
  const [loading, setLoading] = useState(false)
  const [registerDone, setRegisterDone] = useState(false)
  const [swapClass, setSwapClass] = useState('')
  const emailRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setMode(initialMode)
    setRegisterDone(false)
    setError('')
    setHint('')
  }, [initialMode])

  const features = useMemo(() => t.features, [t])

  function switchMode(next: AuthMode) {
    if (next === mode) return
    setError('')
    setHint('')
    setRegisterDone(false)
    setSwapClass('is-leaving')
    window.setTimeout(() => {
      setMode(next)
      setSwapClass('is-entering')
      const path = next === 'login' ? '/login' : '/register'
      // URL sync without Next remount (remount caused outer-card jump + Google re-init)
      if (typeof window !== 'undefined' && window.location.pathname !== path) {
        window.history.replaceState(null, '', path)
      }
      window.requestAnimationFrame(() => {
        window.setTimeout(() => {
          setSwapClass('')
          emailRef.current?.focus()
        }, 16)
      })
    }, 160)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setHint('')
    if (mode === 'register' && password !== confirm) {
      setError(t.mismatch)
      return
    }
    setLoading(true)
    try {
      if (mode === 'login') {
        const result = await postPanelLogin(email, password)
        if (!result.ok) {
          if (result.blocked) {
            router.push('/pending-approval')
            return
          }
          setError(result.message)
          return
        }
        // Panel BFF sets listjetgo_session on app host only. Canonical /app APIs
        // read the SameSite=None cookie on api.listjetgo.com (same as Google GIS).
        if (result.kind === 'user') {
          const apiLogin = await postUserLogin(email, password)
          if (!apiLogin.ok) {
            router.push('/pending-approval')
            return
          }
        }
        router.push(result.kind === 'admin' ? '/dashboard' : '/app/dashboard')
        router.refresh()
        return
      }
      const result = await postPanelRegister({ email, password, product: 'EBAY' })
      if (!result.ok) {
        setError(result.message)
        return
      }
      setRegisterDone(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="lj-auth">
      <div className="lj-auth__lang" role="group" aria-label="Language">
        <button type="button" className={lang === 'tr' ? 'is-active' : ''} onClick={() => setLang('tr')}>
          TR
        </button>
        <button type="button" className={lang === 'en' ? 'is-active' : ''} onClick={() => setLang('en')}>
          EN
        </button>
      </div>

      <section className="lj-auth__visual" aria-label="ListJetGo">
        <div className="lj-auth__map">
          <WorldMap />
        </div>

        <a className="lj-auth__brand" href="/">
          <span className="lj-auth__mark">
            <PlaneMark />
          </span>
          <span className="lj-auth__brand-text">
            <strong>ListJetGo</strong>
            <span>{t.brandSub}</span>
          </span>
        </a>

        <div className="lj-auth__hero">
          <h1>
            {t.headlineBefore} <em>{t.headlineAccent}</em>
          </h1>
          <ul className="lj-auth__features">
            {features.map((label, i) => (
              <li key={label}>
                <span className="lj-auth__feat-icon">
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    {FEAT_ICONS[i]}
                  </svg>
                </span>
                {label}
              </li>
            ))}
          </ul>
        </div>

        <div className="lj-auth__float lj-auth__float--a">
          <strong>{t.floatATitle}</strong>
          <span>{t.floatASub}</span>
        </div>
        <div className="lj-auth__float lj-auth__float--b">
          <strong>{t.floatBTitle}</strong>
          <span>{t.floatBSub}</span>
        </div>
        <div className={`lj-auth__float lj-auth__float--c lj-auth__pill lj-auth__pill--ok`}>{t.floatC}</div>
        <div className={`lj-auth__float lj-auth__float--d lj-auth__pill lj-auth__pill--info`}>{t.floatD}</div>

        <p className="lj-auth__foot-note">{t.foot}</p>
      </section>

      <section className="lj-auth__panel">
        <div className="lj-auth__card">
          <div className="lj-auth__tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'login'}
              className={`lj-auth__tab${mode === 'login' ? ' is-active' : ''}`}
              onClick={() => switchMode('login')}
            >
              {t.tabLogin}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'register'}
              className={`lj-auth__tab${mode === 'register' ? ' is-active' : ''}`}
              onClick={() => switchMode('register')}
            >
              {t.tabRegister}
            </button>
          </div>

          <div className="lj-auth__body">
            {registerDone && mode === 'register' ? (
              <div className="lj-auth__success-box">
                <h3>{t.registerOkTitle}</h3>
                <p>{t.registerOkBody}</p>
                <button type="button" className="lj-auth__submit" onClick={() => switchMode('login')}>
                  {t.goLogin}
                </button>
              </div>
            ) : (
              <>
                <div className="lj-auth__content-slot">
                  <div className={`lj-auth__swap${swapClass ? ` ${swapClass}` : ''}`}>
                    <div className="lj-auth__greeting">
                      <h2>{mode === 'login' ? t.greetLogin : t.greetRegister}</h2>
                      <p>{mode === 'login' ? t.greetLoginSub : t.greetRegisterSub}</p>
                    </div>

                    <form className="lj-auth__form" onSubmit={handleSubmit} noValidate>
                      <label className="lj-auth__field">
                        <span>{t.email}</span>
                        <div className="lj-auth__control">
                          <IconMail />
                          <input
                            ref={emailRef}
                            type="email"
                            autoComplete="email"
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            placeholder="name@example.com"
                          />
                        </div>
                      </label>

                      <label className="lj-auth__field">
                        <span>{t.password}</span>
                        <div className="lj-auth__control">
                          <IconLock />
                          <input
                            type={showPw ? 'text' : 'password'}
                            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                            required
                            minLength={mode === 'register' ? 8 : undefined}
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                          />
                          <button
                            type="button"
                            className="lj-auth__eye"
                            aria-label={showPw ? 'Hide password' : 'Show password'}
                            onClick={() => setShowPw((v) => !v)}
                          >
                            <IconEye off={showPw} />
                          </button>
                        </div>
                      </label>

                      <label
                        className={`lj-auth__field${mode === 'login' ? ' is-reserved' : ''}`}
                        aria-hidden={mode === 'login'}
                      >
                        <span>{t.confirm}</span>
                        <div className="lj-auth__control">
                          <IconLock />
                          <input
                            type={showPw ? 'text' : 'password'}
                            autoComplete="new-password"
                            tabIndex={mode === 'login' ? -1 : 0}
                            required={mode === 'register'}
                            minLength={8}
                            value={confirm}
                            onChange={(e) => setConfirm(e.target.value)}
                            disabled={mode === 'login'}
                          />
                        </div>
                      </label>

                      <div
                        className={`lj-auth__row${mode === 'register' ? ' is-reserved' : ''}`}
                        aria-hidden={mode === 'register'}
                      >
                        <Link
                          href="/forgot-password"
                          className="lj-auth__link"
                          tabIndex={mode === 'register' ? -1 : 0}
                        >
                          {t.forgot}
                        </Link>
                      </div>

                      {error ? (
                        <p className="lj-auth__error">{error}</p>
                      ) : hint ? (
                        <p className="lj-auth__ok">{hint}</p>
                      ) : (
                        <p className="lj-auth__error" aria-hidden>
                          &nbsp;
                        </p>
                      )}

                      <button type="submit" className="lj-auth__submit" disabled={loading}>
                        {loading
                          ? mode === 'login'
                            ? t.loadingLogin
                            : t.loadingRegister
                          : mode === 'login'
                            ? t.submitLogin
                            : t.submitRegister}
                        {!loading && (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
                            <path
                              d="M5 12h14M13 6l6 6-6 6"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        )}
                      </button>
                    </form>
                  </div>
                </div>

                {/* Outside swap: never remount / never translate with tab content */}
                <div className="lj-auth__social">
                  <GoogleSignInButton compact divider orLabel={t.or} />
                </div>

                <div className="lj-auth__trust">
                  <span>256-Bit SSL</span>
                  <span>KVKK</span>
                  <span>ListJetGo</span>
                </div>
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
