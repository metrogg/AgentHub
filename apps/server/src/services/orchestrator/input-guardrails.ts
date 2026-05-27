export interface GuardrailResult {
  ok: boolean
  riskLevel: 'low' | 'medium' | 'high'
  violations: string[]
}

const DANGEROUS_PATTERNS = [
  // 删除操作
  { pattern: /rm\s+-rf\s+\/|rm\s+-rf\s+[~.]|rmdir\s+\/s|del\s+\/f\s+\/s/i, desc: '检测到大规模删除文件/目录命令' },
  { pattern: /rm\s+-rf\s+\*|format\s+[a-z]:/i, desc: '检测到格式化或通配删除命令' },
  // 敏感文件
  { pattern: /\b\.env\b.*\b(delete|remove|rm|清空|删除)\b|\b(delete|remove|rm|清空|删除)\b.*\b\.env\b/i, desc: '检测到对 .env 文件的破坏操作' },
  { pattern: /\b\.git\b.*\b(delete|remove|rm|destroy|删除|破坏)\b|\b(delete|remove|rm|destroy|删除|破坏)\b.*\b\.git\b/i, desc: '检测到对 .git 目录的破坏操作' },
  { pattern: /\b\.ssh\b|\bid_rsa\b|\b\.aws\b|\b\.docker\b/i, desc: '检测到对密钥/凭证目录的访问' },
  // 系统目录
  { pattern: /\/etc\/|C:\\Windows|C:\\Program\s+Files|..\/..\/etc\/|\/sys\/|\/proc\//i, desc: '检测到对系统目录的访问' },
  // 远程推送/部署
  { pattern: /git\s+push\s+origin|git\s+push\s+-f|force\s+push/i, desc: '检测到强制推送远程仓库' },
  { pattern: /deploy\s+to\s+prod|部署到生产|上线|发布到线上/i, desc: '检测到生产环境部署请求' },
  // 数据库危险操作
  { pattern: /drop\s+table|drop\s+database|delete\s+from\s+\w+\s+where\s+1\s*=\s*1|truncate\s+table/i, desc: '检测到数据库破坏性操作' },
  // 越权沙箱
  { pattern: /sudo\s+|chmod\s+777\s+\/|chown\s+root/i, desc: '检测到提权或全局权限修改' },
  // 泄露密钥
  { pattern: /sk-[a-zA-Z0-9]{20,}|Bearer\s+sk-|api[_-]?key.*泄露|把.*密钥.*发出来/i, desc: '检测到密钥泄露请求' },
]

export function checkInputGuardrails(content: string): GuardrailResult {
  const violations: string[] = []
  let maxRisk: GuardrailResult['riskLevel'] = 'low'

  for (const { pattern, desc } of DANGEROUS_PATTERNS) {
    if (pattern.test(content)) {
      violations.push(desc)
      maxRisk = 'high'
    }
  }

  // 中等风险：安装依赖但未指定范围
  if (/npm\s+install\s+[-g]|pip\s+install|cargo\s+install|brew\s+install/i.test(content)) {
    violations.push('检测到全局安装依赖请求，请确认来源可信')
    if (maxRisk === 'low') maxRisk = 'medium'
  }

  // 中等风险：修改配置文件
  if (/修改.*配置|改.*config|overwrite.*config|替换.*配置/i.test(content)) {
    violations.push('检测到配置文件修改请求')
    if (maxRisk === 'low') maxRisk = 'medium'
  }

  return {
    ok: violations.length === 0,
    riskLevel: maxRisk,
    violations,
  }
}
