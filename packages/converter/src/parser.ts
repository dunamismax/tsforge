import type { TemplateInspection } from '@tsforge/contracts'
import { AttachmentSummarySchema, TemplateInspectionSchema } from '@tsforge/contracts'
import iconv from 'iconv-lite'
import PostalMime from 'postal-mime'
import { DEFAULT_INTERNET_CODEPAGE, OFTBuilder } from './mapi'

export class ConversionError extends Error {
  readonly cause: unknown

  constructor(message: string, cause?: unknown) {
    super(message)
    this.name = 'ConversionError'
    this.cause = cause
  }
}

type BodyKind = 'empty' | 'text' | 'html' | 'mixed'

type ParsedAttachment = {
  contentId: string | null
  data: Buffer
  disposition: 'attachment' | 'inline' | null
  filename: string
  mimeType: string
}

type ParsedTemplate = {
  attachments: ParsedAttachment[]
  bodyHtml: Buffer
  bodyKind: BodyKind
  bodyText: string
  inspection: TemplateInspection
  internetCodepage: number
  subject: string
}

const charsetCodepages: Record<string, number> = {
  ascii: 20127,
  big5: 950,
  'euc-jp': 20932,
  gb2312: 936,
  'iso-8859-1': 28591,
  'iso-8859-15': 28605,
  shift_jis: 932,
  'utf-16': 1200,
  'utf-16-be': 1201,
  'utf-16-le': 1200,
  'utf-8': 65001,
}

const normalizeCharset = (value: string) => value.trim().toLowerCase().replaceAll('_', '-')

const canonicalCharset = (value: string) => {
  const normalized = normalizeCharset(value)
  switch (normalized) {
    case 'iso8859-1':
      return 'iso-8859-1'
    case 'iso8859-15':
      return 'iso-8859-15'
    default:
      return normalized
  }
}

const charsetToCodepage = (value: string | null | undefined) => {
  if (!value) {
    return undefined
  }

  const normalized = canonicalCharset(value)
  if (normalized in charsetCodepages) {
    return charsetCodepages[normalized]
  }

  if (/^cp\d+$/.test(normalized)) {
    return Number(normalized.slice(2))
  }

  return undefined
}

const contentToBuffer = (value: ArrayBuffer | string | Uint8Array) => {
  if (typeof value === 'string') {
    return Buffer.from(value, 'utf8')
  }

  if (value instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(value))
  }

  return Buffer.from(value)
}

const stripAngleBrackets = (value: string | null | undefined) => {
  if (!value) {
    return null
  }

  const trimmed = value.trim()
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1)
  }

  return trimmed
}

const toOftFilename = (filename: string) => {
  const lastDot = filename.lastIndexOf('.')
  const stem = lastDot === -1 ? filename : filename.slice(0, lastDot)
  return `${stem}.oft`
}

const normalizeLineEndings = (value: string) => value.replaceAll('\r\n', '\n')

const stripHtml = (value: string) =>
  value
    .replaceAll(/<style[\s\S]*?<\/style>/gi, ' ')
    .replaceAll(/<script[\s\S]*?<\/script>/gi, ' ')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll(/&nbsp;/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()

const previewText = (bodyText: string, bodyHtmlText: string) => {
  const plain = bodyText.trim()
  if (plain.length > 0) {
    return plain.slice(0, 180)
  }

  const htmlPreview = stripHtml(bodyHtmlText)
  return htmlPreview.slice(0, 180)
}

const detectBodyCharsets = (raw: Buffer) => {
  const blocks = raw.toString('latin1').replaceAll('\r\n', '\n').split('\n\n')
  let plainText: { charset: string; codepage: number } | undefined
  let html: { charset: string; codepage: number } | undefined

  for (const block of blocks) {
    if (!/content-type:/i.test(block)) {
      continue
    }

    const contentTypeMatch = block.match(
      /content-type:\s*(text\/plain|text\/html)\b([^\n]*(?:\n[ \t][^\n]*)*)/i,
    )
    if (!contentTypeMatch) {
      continue
    }

    if (/content-disposition:\s*attachment\b/i.test(block)) {
      continue
    }

    const charsetMatch = block.match(/charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i)
    const charset = charsetMatch?.[1] ?? charsetMatch?.[2] ?? charsetMatch?.[3]
    const codepage = charsetToCodepage(charset)
    if (!charset || !codepage) {
      continue
    }

    const part = {
      charset: canonicalCharset(charset),
      codepage,
    }

    const contentType = contentTypeMatch[1]?.toLowerCase()

    if (contentType === 'text/plain' && !plainText) {
      plainText = part
      continue
    }

    if (contentType === 'text/html' && !html) {
      html = part
    }
  }

  return {
    html,
    plainText,
  }
}

const parseBodyKind = (bodyText: string, bodyHtml: string): BodyKind => {
  if (bodyText.length > 0 && bodyHtml.length > 0) {
    return 'mixed'
  }
  if (bodyText.length > 0) {
    return 'text'
  }
  if (bodyHtml.length > 0) {
    return 'html'
  }
  return 'empty'
}

const parseTemplate = async (raw: Buffer, filename: string): Promise<ParsedTemplate> => {
  const message = await PostalMime.parse(raw, {
    attachmentEncoding: 'arraybuffer',
  })

  const charsets = detectBodyCharsets(raw)
  const subject = message.subject ?? ''
  const bodyText = normalizeLineEndings(message.text ?? '')
  const bodyHtmlText = typeof message.html === 'string' ? normalizeLineEndings(message.html) : ''
  const htmlCharset = charsets.html?.charset ?? charsets.plainText?.charset ?? 'utf-8'
  const bodyHtml: Buffer<ArrayBufferLike> =
    bodyHtmlText.length > 0
      ? iconv.encode(bodyHtmlText, htmlCharset, { addBOM: false })
      : Buffer.alloc(0)
  const internetCodepage =
    (bodyText.length > 0 ? charsets.plainText?.codepage : charsets.html?.codepage) ??
    DEFAULT_INTERNET_CODEPAGE

  const attachments = (message.attachments ?? []).map((attachment) => ({
    contentId: stripAngleBrackets(attachment.contentId ?? null),
    data: contentToBuffer(attachment.content),
    disposition:
      attachment.disposition === 'attachment' || attachment.disposition === 'inline'
        ? attachment.disposition
        : null,
    filename: attachment.filename ?? 'attachment.bin',
    mimeType: attachment.mimeType ?? 'application/octet-stream',
  }))

  const attachmentSummaries = AttachmentSummarySchema.array().parse(
    attachments.map((attachment) => ({
      disposition: attachment.disposition,
      filename: attachment.filename,
      hasContentId: attachment.contentId !== null,
      mimeType: attachment.mimeType,
    })),
  )

  const inspection = TemplateInspectionSchema.parse({
    attachmentCount: attachments.length,
    attachments: attachmentSummaries,
    bodyKind: parseBodyKind(bodyText, bodyHtmlText),
    internetCodepage,
    outputFilename: toOftFilename(filename),
    previewText: previewText(bodyText, bodyHtmlText),
    subject,
  })

  return {
    attachments,
    bodyHtml,
    bodyKind: inspection.bodyKind,
    bodyText,
    inspection,
    internetCodepage,
    subject,
  }
}

export const inspectEmltplBuffer = async (input: Uint8Array, filename: string) => {
  try {
    const template = await parseTemplate(Buffer.from(input), filename)
    return template.inspection
  } catch (cause) {
    throw new ConversionError(`Failed to inspect ${filename}`, cause)
  }
}

export const convertEmltplBuffer = async (input: Uint8Array, filename: string) => {
  try {
    const parsed = await parseTemplate(Buffer.from(input), filename)
    const builder = new OFTBuilder()
    builder.subject = parsed.subject
    builder.bodyText = parsed.bodyText
    builder.bodyHtml = parsed.bodyHtml
    builder.internetCodepage = parsed.internetCodepage
    builder.attachments = parsed.attachments

    return {
      inspection: parsed.inspection,
      oft: builder.toBuffer(),
    }
  } catch (cause) {
    throw new ConversionError(`Failed to convert ${filename}`, cause)
  }
}

export { toOftFilename }
