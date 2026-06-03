export interface HumanInterruptPayload {
  messageId: string
  content: string
}

export function appendHumanInterruptConstraint(
  originalDescription: string | null | undefined,
  input: HumanInterruptPayload,
): string {
  const base = (originalDescription ?? '').trimEnd()
  const marker = `[Manager Update ${input.messageId}]`
  if (base.includes(marker)) return base

  const content = input.content.trim()
  if (!content) return base

  const sections = [base, marker, 'Human added or changed this requirement:', content].filter(Boolean)
  return sections.join('\n\n')
}
