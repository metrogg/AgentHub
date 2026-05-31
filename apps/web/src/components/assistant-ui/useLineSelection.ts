import { useCallback, useState } from 'react'

export interface LineSelectionState {
  /** Set of selected line indices (0-based) */
  selectedLines: Set<number>
  /** Number of selected lines */
  selectedCount: number
  /** Whether all lines are selected */
  isAllSelected: boolean
  /** Toggle a single line; if shiftKey, select range from lastClicked */
  toggleLine: (index: number, shiftKey?: boolean) => void
  /** Select a contiguous range */
  selectRange: (start: number, end: number) => void
  /** Clear all selections */
  clearSelection: () => void
  /** Toggle select all / deselect all */
  toggleAll: () => void
  /** Whether the given index is selected */
  isSelected: (index: number) => boolean
  /** Get sorted array of selected indices */
  sortedSelected: number[]
  /** Get min and max selected line indices */
  selectionRange: { min: number; max: number } | null
}

export function useLineSelection(totalLines: number): LineSelectionState {
  const [selectedLines, setSelectedLines] = useState<Set<number>>(() => new Set())
  const [lastClicked, setLastClicked] = useState<number | null>(null)

  const toggleLine = useCallback(
    (index: number, shiftKey?: boolean) => {
      setSelectedLines((prev) => {
        const next = new Set(prev)

        if (shiftKey && lastClicked !== null) {
          // Range selection: add all lines between lastClicked and index
          const start = Math.min(lastClicked, index)
          const end = Math.max(lastClicked, index)
          for (let i = start; i <= end; i++) {
            next.add(i)
          }
        } else {
          // Toggle single line
          if (next.has(index)) {
            next.delete(index)
          } else {
            next.add(index)
          }
        }

        return next
      })
      setLastClicked(index)
    },
    [lastClicked],
  )

  const selectRange = useCallback((start: number, end: number) => {
    setSelectedLines((prev) => {
      const next = new Set(prev)
      const s = Math.max(0, Math.min(start, end))
      const e = Math.min(totalLines - 1, Math.max(start, end))
      for (let i = s; i <= e; i++) {
        next.add(i)
      }
      return next
    })
  }, [totalLines])

  const clearSelection = useCallback(() => {
    setSelectedLines(new Set())
    setLastClicked(null)
  }, [])

  const toggleAll = useCallback(() => {
    setSelectedLines((prev) => {
      if (prev.size === totalLines) return new Set()
      return new Set(Array.from({ length: totalLines }, (_, i) => i))
    })
  }, [totalLines])

  const isSelected = useCallback(
    (index: number) => selectedLines.has(index),
    [selectedLines],
  )

  const sortedSelected = Array.from(selectedLines).sort((a, b) => a - b)

  const selectionRange =
    sortedSelected.length > 0
      ? { min: sortedSelected[0], max: sortedSelected[sortedSelected.length - 1] }
      : null

  return {
    selectedLines,
    selectedCount: selectedLines.size,
    isAllSelected: selectedLines.size === totalLines && totalLines > 0,
    toggleLine,
    selectRange,
    clearSelection,
    toggleAll,
    isSelected,
    sortedSelected,
    selectionRange,
  }
}
