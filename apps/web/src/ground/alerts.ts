import type { RunwayIncursion } from '@anotheratc/sim'

/**
 * The runway-incursion HUD line.
 *
 * One sentence, not a list: an incursion is read under time pressure, and three stacked
 * messages take longer to parse than the situation gives you. The sim already sorts worst
 * first, so the head of the list is the one to act on and the rest are a count.
 */
export function incursionBanner(incursions: readonly RunwayIncursion[]): string {
  const worst = incursions[0]
  if (!worst) return ''
  const mark = worst.severity === 'alert' ? '⛔' : '⚠'
  const rest = incursions.length > 1 ? ` · +${incursions.length - 1} more` : ''
  return `${mark} RUNWAY — ${worst.message}${rest}`
}
