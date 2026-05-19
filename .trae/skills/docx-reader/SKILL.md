---
name: "docx-reader"
description: "Reads and extracts content from local .docx Word documents. Invoke when user wants to read, parse, or analyze Word documents."
---

# DOCX Reader

读取并解析本地 `.docx` Word 文档内容。

## 使用方法

```bash
npx docx2json <file-path>
```

或者使用 `mcp__pdf-reader-mcp_read_pdf` 工具（如果 docx 转 PDF 后）。

## 常用场景

1. **读取本地 Word 文档**：
   - 需求文档
   - 设计文档
   - 会议纪要
   - 投标文件

2. **提取文档内容**：
   - 文本内容
   - 表格数据
   - 图片（如果有）

## 示例命令

```bash
# 基本读取（如果安装了 pandoc）
pandoc document.docx -t plain

# 或使用 mammoth（Node.js）
npx mammoth document.docx

# 或使用 python-docx
python -c "from docx import Document; doc = Document('document.docx'); print('\n'.join([p.text for p in doc.paragraphs]))"
```

## 注意事项

- .docx 本质上是 ZIP 压缩的 XML 文件
- 可以用解压工具（7z/winrar）直接解压查看 XML 内容
- 表格内容在 `word/tables.xml` 中
- 图片在 `word/media/` 目录中

## 快速解析方法

如果只想提取纯文本，可以将 .docx 重命名为 .zip 后解压，然后用以下命令提取文本：

```bash
# Windows PowerShell
Expand-Archive document.docx -DestinationPath temp_docx
Get-Content temp_docx/word/document.xml -Raw | Select-String -Pattern '<w:t[^>]*>([^<]+)</w:t>' -AllMatches | ForEach-Object { $_.Matches.Value -replace '<[^>]+>', '' }
```

## 调用时机

当用户说：
- "帮我读取这个 Word 文档"
- "解析一下这份 docx 文件"
- "看看这个文档写了什么"
- 需要分析本地 .docx 文件内容时