/**
 * Incident vocabulary shared by the two incident screens.
 *
 * The words and the numeric normalizations live apart from the components that draw them
 * for the same reason `lib/format.ts` does: a presentation rule that differs between the
 * list and the detail reads as two different facts. A confidence rendered as "0.72" on one
 * screen and "72%" on the other is a bug the reader has to debug.
 */

import type { IncidentState, RemediationStep } from '../lib/types'

/* -------------------------------------------------------------------------- */
/* Incident state                                                             */
/* -------------------------------------------------------------------------- */

export const INCIDENT_STATES: IncidentState[] = ['open', 'investigating', 'mitigated', 'resolved']

export const INCIDENT_STATE_LABEL: Record<IncidentState, string> = {
  open: 'Open',
  investigating: 'Investigating',
  mitigated: 'Mitigated',
  resolved: 'Resolved',
}

/**
 * State is progress, not severity: open is the alarming end and resolved the reassuring
 * one, so the tone walks that ramp. The label always ships alongside — the chip never
 * asks anyone to decode a color.
 */
export const INCIDENT_STATE_TONE: Record<
  IncidentState,
  'neutral' | 'accent' | 'good' | 'warning' | 'critical'
> = {
  open: 'critical',
  investigating: 'warning',
  mitigated: 'accent',
  resolved: 'good',
}

export const isUnresolved = (state: IncidentState) => state !== 'resolved'

/* -------------------------------------------------------------------------- */
/* Model confidence                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Normalize a confidence to a 0–1 fraction.
 *
 * The correlation task writes a fraction, but a deterministic fallback path can emit
 * 0–100. Guessing wrong turns "68% sure" into "6800% sure", so anything above 1 is read
 * as a percentage rather than trusted as a fraction.
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

/* -------------------------------------------------------------------------- */
/* Remediation steps                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A remediation step arrives either as a plain sentence or as `{step|action|detail}`,
 * depending on whether the model or the fallback produced it. Both shapes reduce to a
 * headline plus optional detail here, so no screen has to branch on the wire format.
 */
export function remediationParts(item: string | RemediationStep): { head: string; detail?: string } {
  if (typeof item === 'string') return { head: item.trim() }

  const head = (item.step || item.action || item.detail || '').trim()
  // Whichever fields the headline did not consume become the detail line.
  const rest = [item.step, item.action, item.detail]
    .map((v) => (v ?? '').trim())
    .filter((v) => v && v !== head)
  return { head: head || 'Step', detail: rest.length ? rest.join(' — ') : undefined }
}

/** Flatten a remediation list to searchable text — used to pre-select a command. */
export function remediationText(items: (string | RemediationStep)[] | null | undefined): string {
  if (!items) return ''
  return items
    .map((item) => {
      const { head, detail } = remediationParts(item)
      return [head, detail].filter(Boolean).join(' ')
    })
    .join(' ')
}
