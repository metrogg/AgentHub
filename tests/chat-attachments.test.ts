import { describe, expect, test } from 'bun:test'
import type { ChatAttachment } from '../apps/web/src/lib/api'
import {
  attachmentInputAccept,
  attachmentKindLabel,
  attachmentToPreviewItem,
  maxAttachmentBytes,
  maxPendingAttachments,
} from '../apps/web/src/components/assistant-ui/ChatAttachments'

function attachment(partial: Partial<ChatAttachment> & Pick<ChatAttachment, 'id' | 'name'>): ChatAttachment {
  return {
    dataUrl: 'data:text/plain;base64,SGVsbG8=',
    mimeType: 'text/plain',
    previewKind: 'text',
    size: 42,
    type: 'file',
    ...partial,
  }
}

describe('chat attachments', () => {
  test('keeps upload limits and accepted formats explicit', () => {
    expect(maxAttachmentBytes).toBe(5 * 1024 * 1024)
    expect(maxPendingAttachments).toBe(6)
    expect(attachmentInputAccept).toContain('image/*')
    expect(attachmentInputAccept).toContain('.docx')
    expect(attachmentInputAccept).toContain('.pptx')
    expect(attachmentInputAccept).toContain('.xlsx')
  })

  test('labels common attachment kinds', () => {
    expect(attachmentKindLabel(attachment({ id: 'txt', name: 'README.md' }))).toBe('文本')
    expect(
      attachmentKindLabel(
        attachment({
          id: 'image',
          mimeType: 'image/png',
          name: 'screen.png',
          previewKind: 'image',
          type: 'image',
        }),
      ),
    ).toBe('图片')
    expect(
      attachmentKindLabel(
        attachment({
          id: 'deck',
          mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          name: 'slides.pptx',
          previewKind: 'document',
        }),
      ),
    ).toBe('演示文稿')
  })

  test('converts attachments into preview items', () => {
    const preview = attachmentToPreviewItem(
      attachment({
        id: 'note',
        name: 'notes.txt',
        text: 'hello',
      }),
    )

    expect(preview).toMatchObject({
      id: 'note',
      kind: 'file',
      path: 'notes.txt',
      source: 'hello',
      title: 'notes.txt',
      url: 'data:text/plain;base64,SGVsbG8=',
    })
    expect(preview.subtitle).toContain('文本')
  })
})
