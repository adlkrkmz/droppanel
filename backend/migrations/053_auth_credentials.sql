-- Expand/migrate credential model. Existing bcrypt hashes are copied byte-for-byte.
CREATE TABLE IF NOT EXISTS password_credentials (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO password_credentials (user_id, password_hash, created_at, updated_at, password_changed_at)
SELECT id, password_hash, created_at, updated_at, updated_at
FROM users
WHERE password_hash IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

-- Google-only users need no password. Column remains temporarily for old-code deploy compatibility.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

CREATE TABLE IF NOT EXISTS external_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  provider_email TEXT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  display_name TEXT NULL,
  last_login_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX IF NOT EXISTS idx_external_identities_user_id ON external_identities(user_id);
CREATE INDEX IF NOT EXISTS idx_external_identities_provider_email ON external_identities(provider, provider_email);
