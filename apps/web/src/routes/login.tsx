import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { authClient } from '#/lib/auth-client'

export const Route = createFileRoute('/login')({
  component: LoginRoute,
})

function LoginRoute() {
  const session = authClient.useSession()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="auth-layout">
      <section className="panel panel-strong">
        <p className="eyebrow">Better Auth + PostgreSQL</p>
        <h1>{session.data?.user ? 'Account' : 'Access persisted history'}</h1>
        <p className="hero-copy">
          The converter works anonymously, but signed-in runs are stored through Drizzle in
          PostgreSQL and are available on the workbench dashboard.
        </p>
        {session.data?.user ? (
          <div className="auth-state">
            <p>
              Signed in as <strong>{session.data.user.email}</strong>
            </p>
            <button
              className="button primary"
              onClick={async () => {
                const result = await authClient.signOut()
                if (result.error) {
                  setError(result.error.message ?? 'Could not sign out.')
                }
              }}
              type="button"
            >
              Sign out
            </button>
          </div>
        ) : (
          <AuthForm error={error} mode={mode} setError={setError} setMode={setMode} />
        )}
      </section>
    </div>
  )
}

function AuthForm({
  error,
  mode,
  setError,
  setMode,
}: {
  error: string | null
  mode: 'signin' | 'signup'
  setError: (value: string | null) => void
  setMode: (value: 'signin' | 'signup') => void
}) {
  return (
    <form
      className="auth-form"
      onSubmit={async (event) => {
        event.preventDefault()
        const form = new FormData(event.currentTarget)
        const email = String(form.get('email') ?? '')
        const password = String(form.get('password') ?? '')
        const name = String(form.get('name') ?? '')

        const response =
          mode === 'signup'
            ? await authClient.signUp.email({
                email,
                name,
                password,
              })
            : await authClient.signIn.email({
                email,
                password,
              })

        if (response.error) {
          setError(response.error.message ?? 'Authentication failed.')
          return
        }

        setError(null)
      }}
    >
      <div className="mode-switch">
        <button
          className={mode === 'signin' ? 'prompt-chip is-selected' : 'prompt-chip'}
          onClick={() => setMode('signin')}
          type="button"
        >
          Sign in
        </button>
        <button
          className={mode === 'signup' ? 'prompt-chip is-selected' : 'prompt-chip'}
          onClick={() => setMode('signup')}
          type="button"
        >
          Create account
        </button>
      </div>
      {mode === 'signup' ? (
        <label className="field">
          <span>Name</span>
          <input name="name" placeholder="Sawyer" required type="text" />
        </label>
      ) : null}
      <label className="field">
        <span>Email</span>
        <input name="email" placeholder="you@example.com" required type="email" />
      </label>
      <label className="field">
        <span>Password</span>
        <input minLength={8} name="password" required type="password" />
      </label>
      {error ? <p className="error-copy">{error}</p> : null}
      <button className="button primary" type="submit">
        {mode === 'signup' ? 'Create account' : 'Sign in'}
      </button>
    </form>
  )
}
