import assert from 'node:assert/strict'
import { ATTACHMENT_MAX_EDGE, attachmentPart, attachmentTargetSize, imageFilesFromClipboard } from './attachments.ts'

assert.deepEqual(attachmentTargetSize(4032, 3024), { width: ATTACHMENT_MAX_EDGE, height: 1176 })
assert.deepEqual(attachmentTargetSize(3024, 4032), { width: 1176, height: ATTACHMENT_MAX_EDGE })
assert.deepEqual(attachmentTargetSize(800, 600), { width: 800, height: 600 })
assert.deepEqual(attachmentTargetSize(ATTACHMENT_MAX_EDGE, ATTACHMENT_MAX_EDGE), { width: ATTACHMENT_MAX_EDGE, height: ATTACHMENT_MAX_EDGE })
const scaled = attachmentTargetSize(1569, 1000)
assert.ok(Number.isInteger(scaled.width) && Number.isInteger(scaled.height))

assert.deepEqual(
  attachmentPart('image/jpeg', 'erro.jpg', 'data:image/jpeg;base64,AAAA'),
  { type: 'file', mime: 'image/jpeg', filename: 'erro.jpg', url: 'data:image/jpeg;base64,AAAA' }
)
assert.throws(() => attachmentPart('image/jpeg', 'erro.jpg', 'https://example.com/erro.jpg'), /data URL/)

// A pasted screenshot reaches the composer as a DataTransferItemList entry; the pasted-text
// sibling is not a file and so the items pass recovers just the image.
const pastedScreenshot = { name: 'screenshot.png', type: 'image/png' }
assert.deepEqual(
  imageFilesFromClipboard({
    items: [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => pastedScreenshot }
    ],
    files: []
  }),
  [pastedScreenshot]
)

// A non-image file that reaches the items path is ignored, not attached.
assert.deepEqual(
  imageFilesFromClipboard({
    items: [
      { kind: 'file', type: 'application/pdf', getAsFile: () => ({ name: 'a.pdf', type: 'application/pdf' }) }
    ],
    files: []
  }),
  [])

// When items carry no image some platforms still expose one on `files`, so the fallback recovers it
// by type.
const pastedJpeg = { name: 'photo.jpg', type: 'image/jpeg' }
assert.deepEqual(
  imageFilesFromClipboard({
    items: [],
    files: [pastedJpeg, { name: 'notes.txt', type: 'text/plain' }]
  }),
  [pastedJpeg]
)

// An empty clipboard yields no attachments and the handler falls through to the default paste.
assert.deepEqual(imageFilesFromClipboard({ items: [], files: [] }), [])

console.log('attachment helper tests passed')
