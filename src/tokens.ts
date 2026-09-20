/**
 * Token estimation.
 *
 * Deliberately the same heuristic S0 used, so the thresholds measured against
 * real sessions and the checks applied at request time agree with each other:
 * a CJK character counts about one token, other characters about a quarter.
 * Accurate to roughly ±20%, which is enough for a budget guard and for
 * choosing a threshold — it is not used for billing.
 *
 * @module dsh-jev-tools/tokens
 */

/** Characters that tokenize near one-per-character. */
function isDense (code: number): boolean {
  return (
    (code >= 0x3040 && code <= 0x30ff) || // kana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK unified ideographs
    (code >= 0xac00 && code <= 0xd7af) || // hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xff00 && code <= 0xffef) // fullwidth forms
  )
}

/**
 * Estimate the token count of a string.
 *
 * @param text - the text to measure.
 * @returns the estimated token count.
 */
export function estimateTokens (text: string): number {
  let dense = 0
  let sparse = 0
  for (const char of text) {
    if (isDense(char.codePointAt(0) ?? 0)) dense += 1
    else sparse += 1
  }
  return dense + sparse / 4
}

/**
 * Estimate the token count of an arbitrary JSON value.
 *
 * @param value - the value to measure.
 * @returns the estimated token count of its serialization.
 */
export function measureJson (value: unknown): number {
  if (typeof value === 'string') return estimateTokens(value)
  if (value === undefined) return 0
  try {
    return estimateTokens(JSON.stringify(value) ?? '')
  } catch {
    return 0
  }
}
