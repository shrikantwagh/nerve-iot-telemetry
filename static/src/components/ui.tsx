/**
 * Shared UI primitives.
 *
 * Everything is written against the theme tokens rather than raw colors, so light and
 * dark stay in step and status meaning stays consistent. Status is always color + text,
 * never color alone.
 */

import type { CSSProperties, ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SEVERITY_TOKEN, STATUS_TOKEN, healthToken, num } from '../lib/format'
import type { DeviceStatus, Severity } from '../lib/types'

/* -------------------------------------------------------------------------- */
/* Surfaces                                                                   */
/* -------------------------------------------------------------------------- */

export function Card({
  children,
  className = '',
  padded = true,
  style,
}: {
  children: ReactNode
  className?: string
  padded?: boolean
  style?: CSSProperties
}) {
  return (
    <section
      className={`rounded-[10px] border ${padded ? 'p-4' : ''} ${className}`}
      style={{
        background: 'var(--surface-1)',
        borderColor: 'var(--surface-3)',
        ...style,
      }}
    >
      {children}
    </section>
  )
}

export function SectionHeader({
  title,
  subtitle,
  action,
}: {
  title: string
  subtitle?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h2>
        {subtitle && (
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
            {subtitle}
          </p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Buttons                                                                    */
/* -------------------------------------------------------------------------- */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

const BUTTON_STYLE: Record<ButtonVariant, CSSProperties> = {
  primary: { background: 'var(--accent)', color: 'var(--on-accent)', borderColor: 'transparent' },
  secondary: {
    background: 'var(--surface-2)',
    color: 'var(--text-primary)',
    borderColor: 'var(--surface-3)',
  },
  ghost: { background: 'transparent', color: 'var(--text-secondary)', borderColor: 'transparent' },
  danger: { background: 'var(--status-critical)', color: 'var(--on-accent)', borderColor: 'transparent' },
}

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled,
  pending,
  type = 'button',
  size = 'md',
  title,
  className = '',
  full,
}: {
  children: ReactNode
  onClick?: () => void
  variant?: ButtonVariant
  disabled?: boolean
  pending?: boolean
  type?: 'button' | 'submit'
  size?: 'sm' | 'md'
  title?: string
  className?: string
  full?: boolean
}) {
  const isOff = disabled || pending
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={isOff}
      title={title}
      className={`inline-flex items-center justify-center gap-1.5 rounded-[6px] border font-medium transition-opacity ${
        size === 'sm' ? 'px-2.5 py-1 text-[12px]' : 'px-3 py-1.5 text-[13px]'
      } ${isOff ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:opacity-85'} ${
        full ? 'w-full' : ''
      } ${className}`}
      style={BUTTON_STYLE[variant]}
    >
      {pending && <Spinner size={12} />}
      {children}
    </button>
  )
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}

/* -------------------------------------------------------------------------- */
/* Status vocabulary — color always paired with a label                       */
/* -------------------------------------------------------------------------- */

export function StatusDot({ status, withLabel = true }: { status: DeviceStatus; withLabel?: boolean }) {
  const token = STATUS_TOKEN[status] ?? STATUS_TOKEN.provisioning
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        className={`inline-block h-2 w-2 shrink-0 rounded-full ${status === 'online' ? 'live-dot' : ''}`}
        style={{ background: token.color }}
        aria-hidden="true"
      />
      {withLabel && (
        <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {token.label}
        </span>
      )}
      {!withLabel && <span className="sr-only">{token.label}</span>}
    </span>
  )
}

export function SeverityBadge({ severity, count }: { severity: Severity; count?: number }) {
  const token = SEVERITY_TOKEN[severity] ?? SEVERITY_TOKEN.info
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-[6px] px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ background: 'var(--surface-2)', color: 'var(--text-primary)' }}
    >
      {/* Icon + label, so severity never depends on hue alone. */}
      <span aria-hidden="true" style={{ color: token.color, fontSize: 9 }}>
        {token.icon}
      </span>
      {token.label}
      {count !== undefined && <span className="num-tabular opacity-70">{count}</span>}
    </span>
  )
}

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'accent' | 'good' | 'warning' | 'critical'
}) {
  const map: Record<string, CSSProperties> = {
    neutral: { background: 'var(--surface-2)', color: 'var(--text-secondary)' },
    accent: { background: 'var(--accent-soft)', color: 'var(--accent)' },
    good: { background: 'var(--surface-2)', color: 'var(--status-good)' },
    warning: { background: 'var(--surface-2)', color: 'var(--status-serious)' },
    critical: { background: 'var(--surface-2)', color: 'var(--status-critical)' },
  }
  return (
    <span
      className="inline-flex items-center rounded-[6px] px-1.5 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={map[tone]}
    >
      {children}
    </span>
  )
}

/**
 * Health meter. The fill carries severity; the track is a recessive step of the same
 * surface, so state reads across the whole bar.
 */
export function HealthMeter({ score, width = 56 }: { score: number | null | undefined; width?: number }) {
  const token = healthToken(score)
  const clamped = Math.max(0, Math.min(100, score ?? 0))
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <span
        className="inline-block overflow-hidden rounded-full"
        style={{ width, height: 5, background: 'var(--surface-3)' }}
        role="img"
        aria-label={`Health ${num(score, 0)} of 100, ${token.label}`}
      >
        <span
          className="block h-full rounded-full"
          style={{ width: `${clamped}%`, background: token.color }}
        />
      </span>
      <span className="num-tabular text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {num(score, 0)}
      </span>
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* States                                                                     */
/* -------------------------------------------------------------------------- */

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string
  hint?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
      <p className="text-[13px] font-medium" style={{ color: 'var(--text-primary)' }}>
        {title}
      </p>
      {hint && (
        <p className="max-w-md text-[12px]" style={{ color: 'var(--text-secondary)' }}>
          {hint}
        </p>
      )}
      {action}
    </div>
  )
}

/**
 * Error state. Rate limiting gets its own message because the remedy is a plan change,
 * not a retry — leaving people to guess at "429" wastes their time.
 */
export function ErrorState({
  error,
  onRetry,
}: {
  error: Error & { status?: number; isRateLimit?: boolean }
  onRetry?: () => void
}) {
  const rateLimited = Boolean(error?.isRateLimit)
  return (
    <div
      className="rounded-[10px] border px-4 py-3"
      style={{ borderColor: 'var(--status-critical)', background: 'var(--surface-1)' }}
    >
      <p className="text-[13px] font-medium" style={{ color: 'var(--status-critical)' }}>
        {rateLimited ? 'Rate limited by Xano' : 'Something went wrong'}
      </p>
      <p className="mt-1 text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {rateLimited
          ? 'This instance is on the Free plan, which allows 10 requests per 20 seconds across the whole instance. Upgrading to Essential removes the limit.'
          : error?.message || 'Unknown error.'}
      </p>
      {onRetry && (
        <div className="mt-2">
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      )}
    </div>
  )
}

export function Skeleton({ height = 16, width = '100%' }: { height?: number; width?: number | string }) {
  return (
    <span
      className="block animate-pulse rounded-[6px]"
      style={{ height, width, background: 'var(--surface-2)' }}
      aria-hidden="true"
    />
  )
}

/* -------------------------------------------------------------------------- */
/* Form controls                                                              */
/* -------------------------------------------------------------------------- */

const controlStyle: CSSProperties = {
  background: 'var(--surface-1)',
  borderColor: 'var(--surface-3)',
  color: 'var(--text-primary)',
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </span>
      {children}
      {hint && (
        <span className="mt-1 block text-[11px]" style={{ color: 'var(--text-muted)' }}>
          {hint}
        </span>
      )}
    </label>
  )
}

export function Input({
  value,
  onChange,
  placeholder,
  type = 'text',
  disabled,
  onEnter,
  autoFocus,
  min,
  step,
}: {
  value: string | number
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  disabled?: boolean
  onEnter?: () => void
  autoFocus?: boolean
  min?: number
  step?: number
}) {
  return (
    <input
      type={type}
      value={value}
      min={min}
      step={step}
      autoFocus={autoFocus}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && onEnter) onEnter()
      }}
      className="w-full rounded-[6px] border px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-50"
      style={controlStyle}
    />
  )
}

export function Select({
  value,
  onChange,
  options,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  disabled?: boolean
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-[6px] border px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-50"
      style={controlStyle}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Textarea({
  value,
  onChange,
  placeholder,
  rows = 3,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  rows?: number
  disabled?: boolean
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="w-full resize-y rounded-[6px] border px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-50"
      style={controlStyle}
    />
  )
}

/** Segmented control — the filter row above charts and tables. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string }[]
}) {
  return (
    <div
      className="inline-flex rounded-[6px] border p-0.5"
      style={{ borderColor: 'var(--surface-3)', background: 'var(--surface-2)' }}
      role="tablist"
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className="cursor-pointer rounded-[4px] px-2.5 py-1 text-[12px] font-medium whitespace-nowrap"
            style={{
              background: active ? 'var(--surface-1)' : 'transparent',
              color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* Overlays                                                                   */
/* -------------------------------------------------------------------------- */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  footer?: ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 pt-[8vh]"
      style={{ background: 'var(--scrim)' }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        ref={ref}
        className={`w-full rounded-[10px] border shadow-xl ${wide ? 'max-w-3xl' : 'max-w-md'}`}
        style={{ background: 'var(--surface-1)', borderColor: 'var(--surface-3)' }}
      >
        <header
          className="flex items-center justify-between border-b px-4 py-3"
          style={{ borderColor: 'var(--surface-3)' }}
        >
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--text-primary)' }}>
            {title}
          </h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer rounded px-1.5 text-[16px] leading-none"
            style={{ color: 'var(--text-muted)' }}
          >
            ×
          </button>
        </header>
        <div className="px-4 py-3">{children}</div>
        {footer && (
          <footer
            className="flex justify-end gap-2 border-t px-4 py-3"
            style={{ borderColor: 'var(--surface-3)' }}
          >
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}

/** Inline banner for a warning that must not be dismissible-and-forgotten. */
export function Banner({
  tone = 'accent',
  children,
  onDismiss,
}: {
  tone?: 'accent' | 'warning' | 'critical'
  children: ReactNode
  onDismiss?: () => void
}) {
  const border =
    tone === 'critical' ? 'var(--status-critical)' : tone === 'warning' ? 'var(--status-serious)' : 'var(--accent)'
  return (
    <div
      className="flex items-start justify-between gap-3 rounded-[10px] border px-3 py-2"
      style={{ borderColor: border, background: 'var(--surface-1)' }}
    >
      <div className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {children}
      </div>
      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="cursor-pointer text-[14px] leading-none"
          style={{ color: 'var(--text-muted)' }}
        >
          ×
        </button>
      )}
    </div>
  )
}

/** Copy-to-clipboard for API keys and serials. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Button
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          window.setTimeout(() => setDone(false), 1600)
        } catch {
          /* clipboard blocked — the value is on screen to select manually */
        }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  )
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                     */
/* -------------------------------------------------------------------------- */

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="scroll-x">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={i}
                className="border-b px-3 py-2 text-left text-[11px] font-medium tracking-wide uppercase whitespace-nowrap"
                style={{ borderColor: 'var(--surface-3)', color: 'var(--text-muted)' }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function Row({
  children,
  to,
  onClick,
}: {
  children: ReactNode
  to?: string
  onClick?: () => void
}) {
  const interactive = Boolean(to || onClick)
  const content = (
    <tr
      onClick={onClick}
      className={interactive ? 'cursor-pointer' : ''}
      style={{ borderColor: 'var(--surface-3)' }}
    >
      {children}
    </tr>
  )
  // A row-wrapping <Link> would be invalid inside <tbody>, so navigation rides the
  // cell content instead — see `LinkCell`.
  return content
}

export function Cell({
  children,
  align = 'left',
  muted,
  nowrap,
}: {
  children: ReactNode
  align?: 'left' | 'right' | 'center'
  muted?: boolean
  nowrap?: boolean
}) {
  return (
    <td
      className={`border-b px-3 py-2 ${nowrap ? 'whitespace-nowrap' : ''}`}
      style={{
        borderColor: 'var(--surface-3)',
        color: muted ? 'var(--text-secondary)' : 'var(--text-primary)',
        textAlign: align,
      }}
    >
      {children}
    </td>
  )
}

export function LinkCell({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Cell nowrap>
      <Link to={to} className="font-medium hover:underline" style={{ color: 'var(--accent)' }}>
        {children}
      </Link>
    </Cell>
  )
}
