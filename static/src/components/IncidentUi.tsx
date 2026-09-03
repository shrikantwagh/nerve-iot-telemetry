/**
 * Presentation atoms shared by the two incident screens (`pages/Incidents.tsx` and
 * `pages/IncidentDetail.tsx`).
 *
 * They live here rather than being duplicated because the incident vocabulary — what an
 * incident state is called, how a model's confidence is drawn, how an AI answer declares
 * its own provenance — has to read identically in the list and in the detail. A
 * confidence that renders as "0.72" on one screen and "72%" on the other reads as two
 * different numbers.
 */

import type { ReactNode } from 'react'
import { Badge } from './ui'
import { dateTime, initials, num } from '../lib/format'
import type { IncidentState, RemediationStep } from '../lib/types'

/* -------------------------------------------------------------------------- */
/* Incident state vocabulary                                                  */
/* -------------------------------------------------------------------------- */

export const INCIDENT_STATES: IncidentState[] = ['open', 'investigating', 'mitigated', 'resolved']

export const INCIDENT_STATE_LABEL: Record<IncidentState, string> = {
  open: 'Open',
  investigating: 'Investigating',
  mitigated: 'Mitigated',
  resolved: 'Resolved',
}

/**
 * State is progress, not severity: an open incident is the alarming end and a resolved
 * one the reassuring end, so the tone walks that ramp. The label always ships with it —
 * the chip never asks anyone to decode a color.
 */
const STATE_TONE: Record<IncidentState, 'neutral' | 'accent' | 'good' | 'warning' | 'critical'> = {
  open: 'critical',
  investigating: 'warning',
  mitigated: 'accent',
  resolved: 'good',
}

export function StateChip({ state }: { state: IncidentState }) {
  const label = INCIDENT_STATE_LABEL[state] ?? state
  return <Badge tone={STATE_TONE[state] ?? 'neutral'}>{label}</Badge>
}

export const isUnresolved = (state: IncidentState) => state !== 'resolved'

/* -------------------------------------------------------------------------- */
/* Model confidence                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a confidence to a 0–1 fraction.
 *
 * The correlation task writes a fraction, but the deterministic fallback path has been
 * seen emitting 0–100. Guessing wrong turns "68% sure" into "6800% sure", so anything
 * above 1 is read as a percentage.
 */
export function confidenceFraction(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null
  if (value <= 0) return 0
  return value > 1 ? Math.min(value / 100, 1) : value
}

/** The words that go next to the bar. A bare 0.62 is not an interpretation. */
export function confidenceBand(fraction: number | null): string {
  if (fraction === null) return 'Not scored'
  if (fraction >= 0.8) return 'High confidence'
  if (fraction >= 0.6) return 'Moderate confidence'
  if (fraction >= 0.4) return 'Low confidence'
  return 'Very low confidence'
}

/**
 * Confidence as a labelled meter.
 *
 * Confidence is a magnitude, not a status, so the fill is the accent rather than a status
 * token — a red bar would read as "critical incident" instead of "the model is unsure".
 * The band word carries the judgement; the number is there for anyone who wants it.
 */
export function ConfidenceMeter({
  value,
  width,
  compactLayout = false,
}: {
  value: number | null | undefined
  width?: number
  compactLayout?: boolean
}) {
  const fraction = confidenceFraction(value)
  const band = confidenceBand(fraction)
  const shown = fraction === null ? 0 : Math.round(fraction * 100)

  return (
    <div className={compactLayout ? 'flex items-center gap-2' : ''}>
      <div
        className="flex items-center justify-between gap-3"
        style={{ width: compactLayout ? undefined : width ?? '100%' }}
      >
        {!compactLayout && (
          <span className="text-[11px] tracking-wide uppercase" style={{ color: 'var(--text-muted)' }}>
            Model confidence
          </span>
        )}
        <span className="text-[12px] font-medium" style={{ color: 'var(--text-secondary)' }}>
          {fraction === null ? band : `${shown}% · ${band}`}
        </span>
      </div>
      <span
        className={`block overflow-hidden rounded-full ${compactLayout ? '' : 'mt-1.5'}`}
        style={{ width: compactLayout ? width ?? 64 : width ?? '100%', height: 6, background: 'var(--surface-3)' }}
        role="img"
        aria-label={
          fraction === null
            ? 'Model confidence not scored'
            : `Model confidence ${shown} percent, ${band.toLowerCase()}`
        }
      >
        <span
          className="block h-full rounded-full"
          style={{
            width: `${shown}%`,
            background: fraction === null ? 'var(--text-muted)' : 'var(--accent)',
          }}
        />
      </span>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/* AI provenance                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where an answer came from.
 *
 * `fallback_used` is the honest bit: when the model call failed, the analysis is a
 * deterministic correlation of the same alerts, and calling that "AI-generated" would be
 * a lie the reader could not detect. So the fallback gets its own sentence, not a
 * suppressed flag.
 */
export function AiProvenance({
  model,
  generatedAt,
  latencyMs,
  fallbackUsed,
  what = 'analysis',
}: {
  model?: string | null
  generatedAt?: string | null
  latencyMs?: number | null
  fallbackUsed?: boolean
  what?: string
}) {
  const parts: string[] = []
  if (!fallbackUsed && model) parts.push(model)
  if (generatedAt) parts.push(dateTime(generatedAt))
  if (latencyMs !== null && latencyMs !== undefined && Number.isFinite(latencyMs))
    parts.push(`${num(latencyMs / 1000, 1)}s`)

  return (
    <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
      {fallbackUsed ? (
        <>
          The model call did not return, so this {what} fell back to deterministic analysis — computed
          from the correlated alerts, not written by a model.
          {parts.length > 0 && <> {parts.join(' · ')}</>}
        </>
      ) : parts.length > 0 ? (
        <>Generated by {parts.join(' · ')}</>
      ) : (
        <>Generated server-side; provenance not recorded.</>
      )}
    </p>
  )
}

/** The "this text came from a model" marker. Never implied, always stated. */
export function AiTag({ children }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <Badge tone="accent">AI</Badge>
      {children}
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* People                                                                     */
/* -------------------------------------------------------------------------- */

export function AssigneeChip({ name, id }: { name?: string | null; id?: number | null }) {
  const assigned = Boolean(name || id)
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span
        aria-hidden="true"
        className="flex h-5 w-5 items-center justify-center rounded-full text-[9px] font-semibold"
        style={{
          background: assigned ? 'var(--accent)' : 'var(--surface-2)',
          color: assigned ? '#fff' : 'var(--text-muted)',
        }}
      >
        {assigned ? initials(name ?? `#${id}`) : '—'}
      </span>
      <span className="text-[12px]" style={{ color: 'var(--text-secondary)' }}>
        {name ?? (id ? `User #${id}` : 'Unassigned')}
      </span>
    </span>
  )
}

/* -------------------------------------------------------------------------- */
/* Remediation steps                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A remediation step arrives either as a plain sentence or as `{step|action|detail}`,
 * depending on whether the model or the fallback produced it. Both shapes reduce to a
 * headline plus optional detail here, so no screen has to branch on the wire format.
 */
export function remediationParts(item: string | RemediationStep): { head: string; detail?: string } {
  if (typeof item === 'string') return { head: item }
  const head = item.step || item.action || item.detail || ''
  const detail = item.step && item.action ? item.action : item.step || item.action ? item.detail : undefined
  return { head: head || 'Step', detail: detail && detail !== head ? detail : undefined }
}

/** Flatten a remediation list to searchable text — used to pre-select a command. */
export function remediationText(items: (string | RemediationStep)[] | null | undefined): string {
  if (!items) return ''
  return items
    .map((i) => {
      const { head, detail } = remediationParts(i)
      return [head, detail].filter(Boolean).join(' ')
    })
    .join(' ')
}
