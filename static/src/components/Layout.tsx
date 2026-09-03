/**
 * App shell: sidebar navigation, header, and the demo-account banner.
 *
 * The nav order is the operator's workflow, not an alphabetical list: you land on
 * Overview, triage Incidents, drill into Fleet, and only then reach configuration.
 */

import type { ReactNode } from 'react'
import { useState } from 'react'
import { Link, NavLink, useLocation } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { initials } from '../lib/format'
import { useTheme } from '../lib/useAsync'
import { Badge, Button } from './ui'

interface NavItem {
  to: string
  label: string
  icon: ReactNode
  badgeKey?: 'incidents' | 'alerts'
}

const icon = (path: string) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={path} />
  </svg>
)

const NAV: NavItem[] = [
  { to: '/', label: 'Overview', icon: icon('M3 12h4l3 8 4-16 3 8h4') },
  { to: '/incidents', label: 'Incidents', icon: icon('M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z'), badgeKey: 'incidents' },
  { to: '/alerts', label: 'Alerts', icon: icon('M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0'), badgeKey: 'alerts' },
  { to: '/fleet', label: 'Fleet', icon: icon('M3 7h18M3 12h18M3 17h18') },
  { to: '/ask', label: 'Ask', icon: icon('M9.1 9a3 3 0 1 1 5.8 1c0 2-3 2-3 4m0 3h.01') },
  { to: '/predictions', label: 'Predictions', icon: icon('M3 17l6-6 4 4 8-8M21 7v6h-6') },
  { to: '/rules', label: 'Rules', icon: icon('M4 6h16M7 12h10M10 18h4') },
  { to: '/admin', label: 'Admin', icon: icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.3 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 7 2.3V2a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 14 3.5a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0 1.2 2.9H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z') },
]

function NerveMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      {/* A nerve impulse: a signal spike travelling a fibre. */}
      <path
        d="M2 14h4l2.5-7 3 12 2.5-9 2 4h6"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function Layout({
  children,
  counts,
}: {
  children: ReactNode
  counts?: { incidents?: number; alerts?: number }
}) {
  const { user, logout, isDemo } = useAuth()
  const [theme, setTheme] = useTheme()
  const [navOpen, setNavOpen] = useState(false)
  const location = useLocation()

  const themeNext: Record<string, 'light' | 'dark' | 'system'> = {
    system: 'light',
    light: 'dark',
    dark: 'system',
  }
  const themeLabel = { system: 'System', light: 'Light', dark: 'Dark' }[theme]

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--surface-0)' }}>
      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-56 shrink-0 border-r transition-transform lg:static lg:translate-x-0 ${
          navOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{ background: 'var(--surface-1)', borderColor: 'var(--surface-3)' }}
      >
        <div className="flex h-14 items-center gap-2 px-4">
          <NerveMark />
          <Link to="/" className="text-[15px] font-semibold no-underline" style={{ color: 'var(--text-primary)' }}>
            Nerve
          </Link>
        </div>

        <nav className="px-2 pb-4">
          {NAV.map((item) => {
            const count = item.badgeKey ? counts?.[item.badgeKey] : undefined
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                onClick={() => setNavOpen(false)}
                className="mb-0.5 flex items-center gap-2.5 rounded-[6px] px-2.5 py-2 text-[13px] no-underline"
                style={({ isActive }) => ({
                  background: isActive ? 'var(--accent-soft)' : 'transparent',
                  color: isActive ? 'var(--accent)' : 'var(--text-secondary)',
                  fontWeight: isActive ? 600 : 400,
                })}
              >
                {item.icon}
                <span className="flex-1">{item.label}</span>
                {count !== undefined && count > 0 && (
                  <span
                    className="num-tabular rounded-full px-1.5 text-[10px] font-semibold"
                    style={{ background: 'var(--status-critical)', color: 'var(--on-accent)' }}
                  >
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </NavLink>
            )
          })}
        </nav>

        <div className="absolute bottom-0 left-0 right-0 border-t p-3" style={{ borderColor: 'var(--surface-3)' }}>
          <div className="mb-2 flex items-center gap-2">
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
              style={{ background: user?.avatar_color || 'var(--accent)', color: 'var(--on-accent)' }}
            >
              {initials(user?.name)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium" style={{ color: 'var(--text-primary)' }}>
                {user?.name ?? 'Signed out'}
              </span>
              <span className="block truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
                {user?.role ?? ''}
              </span>
            </span>
          </div>
          <div className="flex gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setTheme(themeNext[theme])} title="Cycle theme">
              {themeLabel}
            </Button>
            <Button size="sm" variant="ghost" onClick={logout}>
              Sign out
            </Button>
          </div>
        </div>
      </aside>

      {navOpen && (
        <button
          className="fixed inset-0 z-30 lg:hidden"
          style={{ background: 'var(--scrim)' }}
          onClick={() => setNavOpen(false)}
          aria-label="Close navigation"
        />
      )}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b px-4"
          style={{ background: 'var(--surface-1)', borderColor: 'var(--surface-3)' }}
        >
          <button
            className="cursor-pointer lg:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            style={{ color: 'var(--text-secondary)' }}
          >
            {icon('M3 6h18M3 12h18M3 18h18')}
          </button>

          <span className="text-[13px] font-medium" style={{ color: 'var(--text-secondary)' }}>
            {NAV.find((n) => (n.to === '/' ? location.pathname === '/' : location.pathname.startsWith(n.to)))?.label ??
              'Nerve'}
          </span>

          <span className="ml-auto flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              <span
                className="live-dot inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: 'var(--status-good)' }}
                aria-hidden="true"
              />
              Live
            </span>
          </span>
        </header>

        {isDemo && (
          <div
            className="border-b px-4 py-2 text-[12px]"
            style={{ background: 'var(--accent-soft)', borderColor: 'var(--surface-3)', color: 'var(--text-secondary)' }}
          >
            <Badge tone="accent">Demo</Badge>{' '}
            You are signed in to the shared read-only demo account. Acknowledging alerts, issuing commands and
            editing rules are disabled so the live fleet stays intact.
          </div>
        )}

        <main className="min-w-0 flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  )
}
