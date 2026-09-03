/**
 * Sign-in.
 *
 * The demo button is the primary action, not a footnote. A hackathon judge has a few
 * minutes and no account; making them invent a password before they can see anything is
 * exactly the friction this project is arguing against.
 */

import { useState } from 'react'
import { useAuth } from '../lib/auth'
import { useAction } from '../lib/useAsync'
import { Button, Card, Field, Input, Segmented } from '../components/ui'

export default function Login() {
  const { login, signup, demoLogin } = useAuth()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const submit = useAction(async () => {
    if (mode === 'signup') await signup(name.trim(), email.trim(), password)
    else await login(email.trim(), password)
  })

  const demo = useAction(demoLogin)

  const canSubmit =
    email.trim().length > 3 && password.length >= 8 && (mode === 'login' || name.trim().length > 1)

  return (
    <div
      className="flex min-h-screen items-center justify-center p-4"
      style={{ background: 'var(--surface-0)' }}
    >
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="mb-2 flex items-center justify-center gap-2">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M2 14h4l2.5-7 3 12 2.5-9 2 4h6"
                stroke="var(--accent)"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span className="text-[22px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              Nerve
            </span>
          </div>
          <p className="text-[13px]" style={{ color: 'var(--text-secondary)' }}>
            The nervous system for your device fleet.
          </p>
        </div>

        <Card>
          <Button variant="primary" full onClick={() => demo.run()} pending={demo.pending}>
            Explore the live demo
          </Button>
          <p className="mt-2 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
            Read-only account. No signup, no password.
          </p>
          {demo.error && (
            <p className="mt-2 text-center text-[12px]" style={{ color: 'var(--status-critical)' }}>
              {demo.error}
            </p>
          )}

          <div className="my-4 flex items-center gap-3">
            <span className="h-px flex-1" style={{ background: 'var(--surface-3)' }} />
            <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
              or
            </span>
            <span className="h-px flex-1" style={{ background: 'var(--surface-3)' }} />
          </div>

          <div className="mb-3 flex justify-center">
            <Segmented
              value={mode}
              onChange={setMode}
              options={[
                { value: 'login', label: 'Sign in' },
                { value: 'signup', label: 'Create account' },
              ]}
            />
          </div>

          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              if (canSubmit) submit.run()
            }}
          >
            {mode === 'signup' && (
              <Field label="Name">
                <Input value={name} onChange={setName} placeholder="Alex Rivera" />
              </Field>
            )}
            <Field label="Email">
              <Input value={email} onChange={setEmail} type="email" placeholder="you@company.com" />
            </Field>
            <Field
              label="Password"
              hint={mode === 'signup' ? 'At least 8 characters, with a letter and a digit.' : undefined}
            >
              <Input value={password} onChange={setPassword} type="password" placeholder="••••••••" />
            </Field>

            {submit.error && (
              <p className="text-[12px]" style={{ color: 'var(--status-critical)' }}>
                {submit.error}
              </p>
            )}

            <Button type="submit" variant="secondary" full disabled={!canSubmit} pending={submit.pending}>
              {mode === 'signup' ? 'Create account' : 'Sign in'}
            </Button>
          </form>

          {mode === 'signup' && (
            <p className="mt-3 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              The first account created on a fresh workspace becomes the admin.
            </p>
          )}
        </Card>

        <p className="mt-4 text-center text-[11px]" style={{ color: 'var(--text-muted)' }}>
          AI-native IoT telemetry monitoring, built on Xano.
        </p>
      </div>
    </div>
  )
}
