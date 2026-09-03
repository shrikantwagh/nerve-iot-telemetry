/**
 * Auth context.
 *
 * The token lives in localStorage (Xano's documented pattern) and is mirrored in state
 * so the UI reacts to login/logout. The cached user is trusted for the first paint and
 * then revalidated against `/auth/me`, so a stale or revoked token surfaces as a clean
 * logout rather than a wall of 401s.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import api, { setUnauthorizedHandler, tokenStore } from './api'
import type { Role, User } from './types'

interface AuthState {
  user: User | null
  token: string | null
  /** True until the initial token revalidation settles — gates the first render. */
  loading: boolean
  error: string | null
  login: (email: string, password: string) => Promise<void>
  signup: (name: string, email: string, password: string) => Promise<void>
  demoLogin: () => Promise<void>
  logout: () => void
  /** Role hierarchy check: `can('operator')` is true for operator and admin. */
  can: (min: Role) => boolean
  isDemo: boolean
}

const ROLE_RANK: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 }

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => tokenStore.get())
  const [user, setUser] = useState<User | null>(() => tokenStore.getUser())
  // Only block the first paint when there is a token worth revalidating.
  const [loading, setLoading] = useState<boolean>(() => Boolean(tokenStore.get()))
  const [error, setError] = useState<string | null>(null)

  const logout = useCallback(() => {
    tokenStore.clear()
    setToken(null)
    setUser(null)
    setError(null)
  }, [])

  // A 401 from anywhere in the app means the token is dead — drop it once, centrally,
  // instead of letting every screen invent its own recovery.
  useEffect(() => {
    setUnauthorizedHandler(() => logout())
    return () => setUnauthorizedHandler(null)
  }, [logout])

  useEffect(() => {
    if (!token) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    api.auth
      .me()
      .then((fresh) => {
        if (cancelled) return
        setUser(fresh)
        tokenStore.setUser(fresh)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Only a real auth rejection should log the user out. A network blip or a
        // cold-start timeout must not — that would boot people offline.
        const status = (err as { status?: number })?.status
        if (status === 401 || status === 403) logout()
        else setError('Could not reach the backend. Showing cached session.')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token, logout])

  const accept = useCallback((res: { authToken: string; user: User }) => {
    tokenStore.set(res.authToken)
    tokenStore.setUser(res.user)
    setToken(res.authToken)
    setUser(res.user)
    setError(null)
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      accept(await api.auth.login(email, password))
    },
    [accept]
  )

  const signup = useCallback(
    async (name: string, email: string, password: string) => {
      accept(await api.auth.signup(name, email, password))
    },
    [accept]
  )

  const demoLogin = useCallback(async () => {
    accept(await api.auth.demo())
  }, [accept])

  const value = useMemo<AuthState>(
    () => ({
      user,
      token,
      loading,
      error,
      login,
      signup,
      demoLogin,
      logout,
      can: (min: Role) => (user ? ROLE_RANK[user.role] >= ROLE_RANK[min] : false),
      isDemo: Boolean(user?.demo_account),
    }),
    [user, token, loading, error, login, signup, demoLogin, logout]
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
