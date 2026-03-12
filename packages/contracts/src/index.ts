import * as z from 'zod'

export const BodyKindSchema = z.enum(['empty', 'text', 'html', 'mixed'])

export const AttachmentSummarySchema = z.object({
  filename: z.string(),
  mimeType: z.string(),
  disposition: z.enum(['attachment', 'inline']).nullable(),
  hasContentId: z.boolean(),
})

export const TemplateInspectionSchema = z.object({
  subject: z.string(),
  outputFilename: z.string(),
  internetCodepage: z.number(),
  attachmentCount: z.number(),
  attachments: z.array(AttachmentSummarySchema),
  bodyKind: BodyKindSchema,
  previewText: z.string(),
})

export const ConversionRecordSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  sourceFilename: z.string(),
  outputFilename: z.string(),
  subject: z.string(),
  bodyKind: BodyKindSchema,
  attachmentCount: z.number(),
})

export const ConvertTemplateInputSchema = z.object({
  filename: z.string(),
  rawBase64: z.string(),
})

export const ConvertTemplateResultSchema = z.object({
  outputFilename: z.string(),
  oftBase64: z.string(),
  inspection: TemplateInspectionSchema,
  record: ConversionRecordSchema.nullable(),
})

export type AttachmentSummary = z.infer<typeof AttachmentSummarySchema>
export type TemplateInspection = z.infer<typeof TemplateInspectionSchema>
export type ConversionRecord = z.infer<typeof ConversionRecordSchema>
export type ConvertTemplateInput = z.infer<typeof ConvertTemplateInputSchema>
export type ConvertTemplateResult = z.infer<typeof ConvertTemplateResultSchema>

export const decodeConvertTemplateInput = (value: unknown) =>
  ConvertTemplateInputSchema.parse(value)
export const decodeConvertTemplateResult = (value: unknown) =>
  ConvertTemplateResultSchema.parse(value)
export const decodeConversionRecordArray = (value: unknown) =>
  z.array(ConversionRecordSchema).parse(value)
