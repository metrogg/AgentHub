import { type FC } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  File,
  FileCode,
  FileImage,
  FileText,
  XCircle,
} from 'lucide-react'

export interface QAResult {
  passed: boolean
  critical: number
  major: number
  minor: number
}

export interface DeliveryFile {
  name: string
  size: number
  type: string
}

export interface ChecklistItem {
  item: string
  done: boolean
}

export interface DeliveryReportData {
  status: string
  runId?: string
  qaResult?: QAResult
  files: DeliveryFile[]
  checklist: ChecklistItem[]
}

interface DeliveryReportProps {
  data: DeliveryReportData
}

function formatFileSize(bytes: number): string {
  if (bytes === undefined || bytes === null || bytes < 0) return '--'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

const FILE_TYPE_ICONS: Record<string, React.ReactNode> = {
  html: <FileCode className="h-4 w-4 text-orange-400" />,
  htm: <FileCode className="h-4 w-4 text-orange-400" />,
  js: <FileCode className="h-4 w-4 text-yellow-500" />,
  mjs: <FileCode className="h-4 w-4 text-yellow-500" />,
  jsx: <FileCode className="h-4 w-4 text-blue-400" />,
  ts: <FileCode className="h-4 w-4 text-blue-500" />,
  tsx: <FileCode className="h-4 w-4 text-blue-500" />,
  css: <FileCode className="h-4 w-4 text-indigo-400" />,
  scss: <FileCode className="h-4 w-4 text-pink-400" />,
  py: <FileCode className="h-4 w-4 text-green-500" />,
  md: <FileText className="h-4 w-4 text-neutral-500" />,
  json: <FileText className="h-4 w-4 text-neutral-400" />,
  svg: <FileImage className="h-4 w-4 text-purple-400" />,
  png: <FileImage className="h-4 w-4 text-sky-400" />,
  jpg: <FileImage className="h-4 w-4 text-sky-400" />,
  jpeg: <FileImage className="h-4 w-4 text-sky-400" />,
  gif: <FileImage className="h-4 w-4 text-sky-400" />,
  pdf: <FileText className="h-4 w-4 text-red-400" />,
  zip: <File className="h-4 w-4 text-amber-500" />,
  txt: <FileText className="h-4 w-4 text-neutral-400" />,
  yml: <FileText className="h-4 w-4 text-neutral-400" />,
  yaml: <FileText className="h-4 w-4 text-neutral-400" />,
}

function getFileTypeIcon(fileName: string): React.ReactNode {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? ''
  return FILE_TYPE_ICONS[ext] ?? <File className="h-4 w-4 text-neutral-400" />
}

const STATUS_CONFIG: Record<string, { icon: React.ReactNode; label: string; bgClass: string; textClass: string }> = {
  completed: {
    icon: <CheckCircle2 className="h-5 w-5" />,
    label: '交付完成',
    bgClass: 'bg-emerald-50 border-emerald-200',
    textClass: 'text-emerald-700',
  },
  failed: {
    icon: <XCircle className="h-5 w-5" />,
    label: '交付失败',
    bgClass: 'bg-red-50 border-red-200',
    textClass: 'text-red-700',
  },
  cancelled: {
    icon: <XCircle className="h-5 w-5" />,
    label: '已取消',
    bgClass: 'bg-neutral-50 border-neutral-200',
    textClass: 'text-neutral-600',
  },
  partial: {
    icon: <AlertTriangle className="h-5 w-5" />,
    label: '部分完成',
    bgClass: 'bg-amber-50 border-amber-200',
    textClass: 'text-amber-700',
  },
}

const DeliveryReport: FC<DeliveryReportProps> = ({ data }) => {
  const { status, runId, qaResult, files, checklist } = data
  const statusCfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.partial

  const totalIssues = qaResult ? qaResult.critical + qaResult.major + qaResult.minor : 0

  return (
    <div className="not-prose my-3 overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
      <div className={`flex items-center gap-3 border-b px-5 py-3 ${statusCfg.bgClass}`}>
        <span className={statusCfg.textClass}>{statusCfg.icon}</span>
        <span className={`text-sm font-semibold ${statusCfg.textClass}`}>{statusCfg.label}</span>
      </div>

      {qaResult && (
        <div className="border-b border-neutral-100 px-5 py-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
            QA 审查结果
          </div>
          <div className="flex items-center gap-2">
            {qaResult.passed ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                <CheckCircle2 className="h-3 w-3" />
                通过
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-0.5 text-xs font-medium text-red-700">
                <XCircle className="h-3 w-3" />
                未通过
              </span>
            )}
            {totalIssues > 0 && (
              <div className="flex items-center gap-2 text-xs text-neutral-500">
                {qaResult.critical > 0 && (
                  <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-red-700">
                    严重 {qaResult.critical}
                  </span>
                )}
                {qaResult.major > 0 && (
                  <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-1.5 py-0.5 text-amber-700">
                    主要 {qaResult.major}
                  </span>
                )}
                {qaResult.minor > 0 && (
                  <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-blue-700">
                    次要 {qaResult.minor}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {files.length > 0 && (
        <div className="border-b border-neutral-100 px-5 py-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
            交付文件 ({files.length})
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-100 text-left text-xs text-neutral-400">
                <th className="pb-1.5 font-medium">文件名</th>
                <th className="pb-1.5 font-medium">大小</th>
                <th className="pb-1.5 font-medium">类型</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-50">
              {files.map((file, idx) => (
                <tr key={`${file.name}-${idx}`} className="text-neutral-700">
                  <td className="py-1.5 pr-3">
                    <div className="flex items-center gap-2">
                      {getFileTypeIcon(file.name)}
                      <span className="max-w-[180px] truncate font-mono text-xs">{file.name}</span>
                    </div>
                  </td>
                  <td className="py-1.5 pr-3 text-xs text-neutral-500">
                    {formatFileSize(file.size)}
                  </td>
                  <td className="py-1.5">
                    <span className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-neutral-500">
                      {file.type}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {checklist.length > 0 && (
        <div className="px-5 py-3">
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-400">
            功能完成清单
          </div>
          <div className="space-y-1.5">
            {checklist.map((item, idx) => (
              <label
                key={`${item.item}-${idx}`}
                className="flex items-start gap-2.5 text-sm text-neutral-700"
              >
                <span
                  className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                    item.done
                      ? 'border-emerald-400 bg-emerald-50 text-emerald-600'
                      : 'border-neutral-300 bg-white'
                  }`}
                >
                  {item.done && <CheckCircle2 className="h-3 w-3" />}
                </span>
                <span className={item.done ? '' : 'text-neutral-400 line-through'}>
                  {item.item}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {files.length > 0 && runId && (
        <div className="border-t border-neutral-100 px-5 py-3">
          <button
            type="button"
            onClick={() => window.open(`/api/artifacts/${runId}/download`, '_blank')}
            className="inline-flex items-center gap-2 rounded-lg bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-700 transition hover:bg-indigo-100"
          >
            <Download className="h-4 w-4" />
            导出产物 (ZIP)
          </button>
        </div>
      )}
    </div>
  )
}

export default DeliveryReport