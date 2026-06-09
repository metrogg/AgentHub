type PptxPreviewerLike = {
  pptx?: {
    slides?: PptxSlideLike[]
  }
}

type PptxSlideLike = {
  nodes?: PptxNodeLike[]
}

type PptxNodeLike = {
  textBody?: {
    paragraphs?: PptxParagraphLike[]
  }
}

type PptxParagraphLike = {
  props?: PptxTextStyle & {
    defRPr?: PptxTextStyle
  }
  inheritRProps?: PptxTextStyle
  rows?: PptxTextRowLike[]
}

type PptxTextRowLike = {
  props?: PptxTextStyle
  text?: string
}

type PptxTextStyle = {
  background?: PptxColor
  bold?: boolean
  color?: PptxColor
  italic?: boolean
  size?: number
  strike?: string
  typeface?: string
  underline?: string
}

type PptxColor = {
  alpha?: number
  color?: string
  type?: string
}

type PptxTextRunStyle = {
  bold?: boolean
  color?: string
  fontFamily?: string
  fontSize?: number
  italic?: boolean
  strike?: boolean
  underline?: boolean
}

type PptxTextRun = {
  style: PptxTextRunStyle
  text: string
}

export function normalizePptxPreviewDom(hostContainer: HTMLElement, previewer: unknown) {
  const slides = (previewer as PptxPreviewerLike | null)?.pptx?.slides
  if (!slides?.length) return

  const slideElements = Array.from(
    hostContainer.querySelectorAll<HTMLElement>('.pptx-preview-slide-wrapper'),
  )

  slideElements.forEach((slideElement, slideIndex) => {
    const runs = collectPptxTextRuns(slides[slideIndex])
    if (!runs.length) return

    const usedRuns = new Set<number>()
    const spans = Array.from(slideElement.querySelectorAll<HTMLElement>('span'))

    spans.forEach((span) => {
      const text = normalizePptxText(span.textContent)
      if (!text) return

      const runIndex = findMatchingRun(runs, usedRuns, text)
      if (runIndex < 0) return

      usedRuns.add(runIndex)
      applyPptxTextRunStyle(span, runs[runIndex].style)
    })
  })
}

function collectPptxTextRuns(slide?: PptxSlideLike): PptxTextRun[] {
  const runs: PptxTextRun[] = []

  for (const node of slide?.nodes ?? []) {
    for (const paragraph of node.textBody?.paragraphs ?? []) {
      for (const row of paragraph.rows ?? []) {
        const text = normalizePptxText(row.text)
        if (!text) continue

        const style = mergePptxTextStyles(
          paragraph.inheritRProps,
          paragraph.props?.defRPr,
          row.props,
        )
        runs.push({ style, text })
      }
    }
  }

  return runs
}

function mergePptxTextStyles(...styles: Array<PptxTextStyle | undefined>): PptxTextRunStyle {
  const output: PptxTextRunStyle = {}

  for (const style of styles) {
    if (!style) continue
    const color = pptxColorToCss(style.color)
    if (color) output.color = color
    if (typeof style.size === 'number' && Number.isFinite(style.size)) output.fontSize = style.size
    if (typeof style.bold === 'boolean') output.bold = style.bold
    if (typeof style.italic === 'boolean') output.italic = style.italic
    if (style.underline && style.underline !== 'none') output.underline = true
    if (style.strike && style.strike !== 'noStrike') output.strike = true
    if (style.typeface) output.fontFamily = style.typeface
  }

  return output
}

function findMatchingRun(runs: PptxTextRun[], usedRuns: Set<number>, text: string) {
  const exactIndex = runs.findIndex((run, index) => !usedRuns.has(index) && run.text === text)
  if (exactIndex >= 0) return exactIndex

  return runs.findIndex((run, index) => {
    if (usedRuns.has(index)) return false
    return run.text.includes(text) || text.includes(run.text)
  })
}

function applyPptxTextRunStyle(span: HTMLElement, style: PptxTextRunStyle) {
  if (style.color) span.style.color = style.color
  if (style.fontSize) {
    span.style.fontSize = `${style.fontSize}px`
    span.style.lineHeight = '1.15'
    span.parentElement?.style.setProperty('font-size', `${style.fontSize}px`)
    span.parentElement?.style.setProperty('line-height', '1.15')
  }
  if (style.fontFamily) span.style.fontFamily = style.fontFamily
  if (typeof style.bold === 'boolean') span.style.fontWeight = style.bold ? '700' : '400'
  if (typeof style.italic === 'boolean') span.style.fontStyle = style.italic ? 'italic' : 'normal'
  if (style.underline || style.strike) {
    span.style.textDecoration = [
      style.underline ? 'underline' : '',
      style.strike ? 'line-through' : '',
    ].filter(Boolean).join(' ')
  }
}

function pptxColorToCss(color?: PptxColor) {
  const raw = color?.color
  if (!raw) return ''

  const hex = raw.startsWith('#') ? raw : `#${raw}`
  if (!/^#[\da-fA-F]{6}$/.test(hex)) return ''

  const alpha = typeof color.alpha === 'number' ? color.alpha : 1
  if (alpha >= 1) return hex

  const red = Number.parseInt(hex.slice(1, 3), 16)
  const green = Number.parseInt(hex.slice(3, 5), 16)
  const blue = Number.parseInt(hex.slice(5, 7), 16)
  return `rgba(${red}, ${green}, ${blue}, ${Math.max(0, Math.min(1, alpha))})`
}

function normalizePptxText(value?: string | null) {
  return (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
}
