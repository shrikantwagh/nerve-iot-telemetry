/**
 * Sparkline — hand-rolled SVG rather than a chart library.
 *
 * A stat tile's trend line has no axes, no legend and no hover; it is a shape, not a
 * chart. Rendering it as a bare polyline keeps a dozen of them on the overview cheap,
 * and avoids Recharts' ResponsiveContainer measuring in a 24px-tall box.
 */

export function Sparkline({
  values,
  width = 96,
  height = 24,
  color = 'var(--series-1)',
  /** De-emphasise all but the final segment, per the stat-tile contract. */
  emphasiseLast = true,
  ariaLabel,
}: {
  values: (number | null)[]
  width?: number
  height?: number
  color?: string
  emphasiseLast?: boolean
  ariaLabel?: string
}) {
  const clean = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
  if (clean.length < 2) {
    return (
      <span
        className="inline-block"
        style={{ width, height, background: 'var(--surface-2)', borderRadius: 4 }}
        aria-hidden="true"
      />
    )
  }

  const min = Math.min(...clean)
  const max = Math.max(...clean)
  const span = max - min || 1
  const pad = 2

  const x = (i: number) => (i / (clean.length - 1)) * (width - pad * 2) + pad
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2)

  const points = clean.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
  const lastTwo = clean.length >= 2 ? clean.slice(-2) : []
  const tailPoints =
    lastTwo.length === 2
      ? `${x(clean.length - 2).toFixed(1)},${y(lastTwo[0]).toFixed(1)} ${x(clean.length - 1).toFixed(1)},${y(
          lastTwo[1]
        ).toFixed(1)}`
      : ''

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
      aria-hidden={ariaLabel ? undefined : true}
      style={{ display: 'block', overflow: 'visible' }}
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeOpacity={emphasiseLast ? 0.4 : 1}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {emphasiseLast && tailPoints && (
        <polyline
          points={tailPoints}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
        />
      )}
      {/* End dot with a 2px surface ring, so it reads against the line and the card. */}
      <circle
        cx={x(clean.length - 1)}
        cy={y(clean[clean.length - 1])}
        r={2.5}
        fill={color}
        stroke="var(--surface-1)"
        strokeWidth={2}
      />
    </svg>
  )
}
