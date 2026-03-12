import { randomUUID } from 'node:crypto'
import { createFileRoute } from '@tanstack/react-router'
import {
  ConversionRecordSchema,
  ConvertTemplateResultSchema,
  decodeConvertTemplateInput,
} from '@tsforge/contracts'
import { convertEmltplBuffer } from '@tsforge/converter'
import { getDb, schema } from '@tsforge/db'
import { withServerSpan } from '@tsforge/observability'
import { desc, eq } from 'drizzle-orm'
import { getServerSession } from '#/lib/auth'

const encodeRecord = (record: typeof schema.conversionJob.$inferSelect) =>
  ConversionRecordSchema.parse({
    attachmentCount: record.attachmentCount,
    bodyKind: record.bodyKind,
    createdAt: record.createdAt.toISOString(),
    id: record.id,
    outputFilename: record.outputFilename,
    sourceFilename: record.sourceFilename,
    subject: record.subject,
  })

export const Route = createFileRoute('/api/conversions')({
  server: {
    handlers: {
      GET: async ({ request }) =>
        withServerSpan('api.conversions.list', async () => {
          const session = await getServerSession(request.headers)
          const db = getDb()
          if (!session?.user || !db) {
            return Response.json([])
          }

          const records = await db
            .select()
            .from(schema.conversionJob)
            .where(eq(schema.conversionJob.userId, session.user.id))
            .orderBy(desc(schema.conversionJob.createdAt))
            .limit(12)

          return Response.json(records.map(encodeRecord))
        }),
      POST: async ({ request }) =>
        withServerSpan('api.conversions.create', async () => {
          const input = decodeConvertTemplateInput(await request.json())
          const buffer = Buffer.from(input.rawBase64, 'base64')
          const session = await getServerSession(request.headers)
          const db = getDb()
          const result = await convertEmltplBuffer(buffer, input.filename)

          let record: ReturnType<typeof encodeRecord> | null = null
          if (session?.user && db) {
            const [inserted] = await db
              .insert(schema.conversionJob)
              .values({
                attachmentCount: result.inspection.attachmentCount,
                attachments: result.inspection.attachments,
                bodyKind: result.inspection.bodyKind,
                createdAt: new Date(),
                id: randomUUID(),
                internetCodepage: result.inspection.internetCodepage,
                outputFilename: result.inspection.outputFilename,
                previewText: result.inspection.previewText,
                sourceFilename: input.filename,
                subject: result.inspection.subject,
                userId: session.user.id,
              })
              .returning()

            if (inserted) {
              record = encodeRecord(inserted)
            }
          }

          const payload = ConvertTemplateResultSchema.parse({
            inspection: result.inspection,
            oftBase64: result.oft.toString('base64'),
            outputFilename: result.inspection.outputFilename,
            record,
          })

          return Response.json(payload)
        }),
    },
  },
})
