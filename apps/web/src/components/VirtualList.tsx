import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

type VirtualListProps<T> = {
  className?: string
  estimateSize: (item: T, index: number) => number
  getKey: (item: T, index: number) => string
  items: T[]
  overscanPx?: number
  renderItem: (item: T, index: number) => ReactNode
  scrollRef: RefObject<HTMLElement>
}

type ScrollFrame = {
  listTop: number
  scrollTop: number
  viewportHeight: number
}

export function VirtualList<T>({
  className,
  estimateSize,
  getKey,
  items,
  overscanPx = 900,
  renderItem,
  scrollRef,
}: VirtualListProps<T>) {
  const listRef = useRef<HTMLDivElement>(null)
  const [rowHeights, setRowHeights] = useState<Map<string, number>>(() => new Map())
  const [scrollFrame, setScrollFrame] = useState<ScrollFrame>({
    listTop: 0,
    scrollTop: 0,
    viewportHeight: 0,
  })

  const updateScrollFrame = useCallback(() => {
    const scrollElement = scrollRef.current
    const listElement = listRef.current
    if (!scrollElement || !listElement) return

    const scrollRect = scrollElement.getBoundingClientRect()
    const listRect = listElement.getBoundingClientRect()
    setScrollFrame({
      listTop: listRect.top - scrollRect.top + scrollElement.scrollTop,
      scrollTop: scrollElement.scrollTop,
      viewportHeight: scrollElement.clientHeight,
    })
  }, [scrollRef])

  useEffect(() => {
    const scrollElement = scrollRef.current
    if (!scrollElement) return

    updateScrollFrame()
    scrollElement.addEventListener('scroll', updateScrollFrame, { passive: true })
    window.addEventListener('resize', updateScrollFrame)

    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(updateScrollFrame)
        : null
    if (observer) {
      observer.observe(scrollElement)
      if (listRef.current) observer.observe(listRef.current)
    }

    return () => {
      scrollElement.removeEventListener('scroll', updateScrollFrame)
      window.removeEventListener('resize', updateScrollFrame)
      observer?.disconnect()
    }
  }, [scrollRef, updateScrollFrame])

  useEffect(() => {
    updateScrollFrame()
  }, [items.length, updateScrollFrame])

  const updateRowHeight = useCallback((key: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) return
    setRowHeights((current) => {
      const previous = current.get(key)
      if (previous !== undefined && Math.abs(previous - height) < 1) return current
      const next = new Map(current)
      next.set(key, height)
      return next
    })
  }, [])

  const windowed = useMemo(() => {
    const measurements = items.map((item, index) => {
      const key = getKey(item, index)
      const size = rowHeights.get(key) ?? Math.max(1, estimateSize(item, index))
      return { end: 0, index, item, key, size, start: 0 }
    })

    let totalSize = 0
    for (const measurement of measurements) {
      measurement.start = totalSize
      totalSize += measurement.size
      measurement.end = totalSize
    }

    if (!measurements.length) {
      return { bottomPadding: 0, topPadding: 0, visible: [] }
    }

    const viewportStart = Math.max(0, scrollFrame.scrollTop - scrollFrame.listTop)
    const viewportEnd = viewportStart + Math.max(1, scrollFrame.viewportHeight)
    const startBoundary = Math.max(0, viewportStart - overscanPx)
    const endBoundary = viewportEnd + overscanPx
    const visible = measurements.filter(
      (measurement) =>
        measurement.end >= startBoundary && measurement.start <= endBoundary,
    )

    if (!visible.length) {
      return { bottomPadding: totalSize, topPadding: 0, visible: [] }
    }

    const first = visible[0]!
    const last = visible[visible.length - 1]!
    return {
      bottomPadding: Math.max(0, totalSize - last.end),
      topPadding: first.start,
      visible,
    }
  }, [estimateSize, getKey, items, overscanPx, rowHeights, scrollFrame])

  return (
    <div ref={listRef} className={className}>
      {windowed.topPadding > 0 && (
        <div aria-hidden="true" style={{ height: windowed.topPadding }} />
      )}
      {windowed.visible.map(({ index, item, key }) => (
        <VirtualListMeasuredRow key={key} itemKey={key} onSize={updateRowHeight}>
          {renderItem(item, index)}
        </VirtualListMeasuredRow>
      ))}
      {windowed.bottomPadding > 0 && (
        <div aria-hidden="true" style={{ height: windowed.bottomPadding }} />
      )}
    </div>
  )
}

function VirtualListMeasuredRow({
  children,
  itemKey,
  onSize,
}: {
  children: ReactNode
  itemKey: string
  onSize: (key: string, height: number) => void
}) {
  const rowRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const row = rowRef.current
    if (!row) return

    const measure = () => onSize(itemKey, row.getBoundingClientRect().height)
    measure()

    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [itemKey, onSize])

  return (
    <div ref={rowRef} style={{ overflowAnchor: 'none' }}>
      {children}
    </div>
  )
}
