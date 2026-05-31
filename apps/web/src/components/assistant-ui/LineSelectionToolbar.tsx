import type { FC } from 'react'
import { Pencil, Quote, X } from 'lucide-react'

interface LineSelectionToolbarProps {
  selectedCount: number
  onReference: () => void
  onEdit?: () => void
  onClear: () => void
}

const LineSelectionToolbar: FC<LineSelectionToolbarProps> = ({
  selectedCount,
  onReference,
  onEdit,
  onClear,
}) => {
  if (selectedCount === 0) return null

  return (
    <div className="agenthub-line-selection-toolbar">
      <span className="agenthub-line-selection-count">
        已选 {selectedCount} 行
      </span>
      <div className="agenthub-line-selection-actions">
        <button
          type="button"
          className="agenthub-line-selection-btn agenthub-line-selection-btn-primary"
          onClick={onReference}
          title="引用选中行到对话输入框"
        >
          <Quote className="h-3.5 w-3.5" />
          引用到对话
        </button>
        {onEdit && (
          <button
            type="button"
            className="agenthub-line-selection-btn"
            onClick={onEdit}
            title="编辑选中行"
          >
            <Pencil className="h-3.5 w-3.5" />
            编辑
          </button>
        )}
        <button
          type="button"
          className="agenthub-line-selection-btn agenthub-line-selection-btn-ghost"
          onClick={onClear}
          title="清除选择"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}

export default LineSelectionToolbar
