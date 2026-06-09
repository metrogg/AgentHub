export function questionMarkMojibakeField(values: Record<string, unknown>) {
  return Object.entries(values).find(([, value]) => looksLikeQuestionMarkMojibake(value))?.[0] ?? null
}

function looksLikeQuestionMarkMojibake(value: unknown) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (!trimmed) return false
  if (/^\?{2,}$/.test(trimmed)) return true
  const visible = trimmed.replace(/\s+/g, '')
  if (visible.length < 6) return false
  const questionCount = [...visible].filter((char) => char === '?').length
  return questionCount >= 4 && questionCount / visible.length >= 0.6
}
