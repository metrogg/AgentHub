import { useEffect, useMemo, useState } from 'react'

export function TypewriterHeading({ text }: { text: string }) {
  const chars = useMemo(() => Array.from(text), [text])
  const [visibleCount, setVisibleCount] = useState(0)
  const done = visibleCount >= chars.length

  useEffect(() => {
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduceMotion) {
      setVisibleCount(chars.length)
      return
    }

    setVisibleCount(0)
    let index = 0
    let timer: number | undefined

    const tick = () => {
      index += 1
      setVisibleCount(index)
      if (index >= chars.length) return

      const current = chars[index - 1]
      const delay = current === '，' || current === '？' || current === '?' ? 150 : 72
      timer = window.setTimeout(tick, delay)
    }

    timer = window.setTimeout(tick, 180)
    return () => {
      if (timer) window.clearTimeout(timer)
    }
  }, [chars, text])

  return (
    <span className="agenthub-typewriter" aria-label={text}>
      <span className="invisible col-start-1 row-start-1" aria-hidden="true">
        {text}
      </span>
      <span className="col-start-1 row-start-1" aria-hidden="true">
        {chars.slice(0, visibleCount).join('')}
        <span className="agenthub-typewriter-caret" data-done={done ? 'true' : 'false'} />
      </span>
    </span>
  )
}
