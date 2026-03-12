import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute, Link } from '@tanstack/react-router'
import {
  type ConvertTemplateResult,
  decodeConversionRecordArray,
  decodeConvertTemplateResult,
} from '@tsforge/contracts'
import { startTransition, useState } from 'react'
import { authClient } from '#/lib/auth-client'

const arrayBufferToBase64 = (value: ArrayBuffer) => {
  const bytes = new Uint8Array(value)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

const base64ToUint8Array = (value: string) => {
  const binary = atob(value)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const downloadFile = (result: ConvertTemplateResult) => {
  const blob = new Blob([base64ToUint8Array(result.oftBase64)], {
    type: 'application/vnd.ms-outlook',
  })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = result.outputFilename
  anchor.click()
  URL.revokeObjectURL(url)
}

const listRecentConversions = async () => {
  const response = await fetch('/api/conversions')
  if (!response.ok) {
    throw new Error('Failed to load conversion history.')
  }
  return decodeConversionRecordArray(await response.json())
}

const uploadTemplate = async (file: File) => {
  const response = await fetch('/api/conversions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      filename: file.name,
      rawBase64: arrayBufferToBase64(await file.arrayBuffer()),
    }),
  })

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(payload?.error ?? 'Conversion failed.')
  }

  return decodeConvertTemplateResult(await response.json())
}

export const Route = createFileRoute('/')({
  component: IndexRoute,
})

function IndexRoute() {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [result, setResult] = useState<ConvertTemplateResult | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const queryClient = useQueryClient()
  const session = authClient.useSession()

  const historyQuery = useQuery({
    queryKey: ['recent-conversions'],
    queryFn: listRecentConversions,
    enabled: Boolean(session.data?.user),
  })

  const uploadMutation = useMutation({
    mutationFn: uploadTemplate,
    onSuccess: (value) => {
      startTransition(() => {
        setResult(value)
        setUploadError(null)
      })
      queryClient.invalidateQueries({
        queryKey: ['recent-conversions'],
      })
    },
    onError: (error) => {
      setUploadError(error instanceof Error ? error.message : 'Conversion failed.')
    },
  })

  return (
    <div className="page-grid">
      <section className="hero">
        <p className="eyebrow">Python retired. Bun-native workflow in production.</p>
        <h1>Forge Outlook templates from raw `.emltpl` sources.</h1>
        <p className="hero-copy">
          The original repo was a stdlib Python converter. This rewrite keeps that binary conversion
          contract, then layers in TanStack Start, Drizzle, Better Auth, and a Bun-native TypeScript
          workspace around it.
        </p>
        <div className="hero-actions">
          <Link className="button secondary" to="/login">
            {session.data?.user ? 'Manage account' : 'Sign in for history'}
          </Link>
          {result ? (
            <button className="button primary" onClick={() => downloadFile(result)} type="button">
              Download {result.outputFilename}
            </button>
          ) : null}
        </div>
      </section>

      <section className="panel panel-strong">
        <div className="panel-header">
          <div>
            <p className="panel-label">Converter</p>
            <h2>Upload one `.emltpl` template</h2>
          </div>
          <span className="status-chip">{uploadMutation.isPending ? 'Converting' : 'Ready'}</span>
        </div>
        <label className="dropzone" htmlFor="template-upload">
          <input
            accept=".emltpl,message/rfc822"
            id="template-upload"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null
              setSelectedFile(file)
            }}
            type="file"
          />
          <strong>{selectedFile ? selectedFile.name : 'Select an email template'}</strong>
          <span>
            Source files are POSTed to the TanStack Start server route, converted to `.oft`, and
            streamed back to the browser for download.
          </span>
        </label>
        <div className="action-row">
          <button
            className="button primary"
            disabled={!selectedFile || uploadMutation.isPending}
            onClick={() => {
              if (selectedFile) {
                uploadMutation.mutate(selectedFile)
              }
            }}
            type="button"
          >
            Convert to `.oft`
          </button>
          <p className="muted-copy">
            {session.data?.user
              ? 'Signed-in runs are saved to PostgreSQL.'
              : 'Anonymous runs still convert, but history is not persisted.'}
          </p>
        </div>
        {uploadError ? <p className="error-copy">{uploadError}</p> : null}
        {result ? <InspectionCard result={result} /> : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="panel-label">Recent runs</p>
            <h2>Postgres-backed activity</h2>
          </div>
        </div>
        {!session.data?.user ? (
          <p className="muted-copy">
            Sign in on the <Link to="/login">auth page</Link> to store conversion metadata and make
            this list useful.
          </p>
        ) : historyQuery.isLoading ? (
          <p className="muted-copy">Loading activity…</p>
        ) : historyQuery.data && historyQuery.data.length > 0 ? (
          <ul className="history-list">
            {historyQuery.data.map((record) => (
              <li className="history-item" key={record.id}>
                <div>
                  <strong>{record.outputFilename}</strong>
                  <p>{record.subject || '(no subject)'}</p>
                </div>
                <div className="history-meta">
                  <span>{record.attachmentCount} attachments</span>
                  <span>{new Date(record.createdAt).toLocaleString()}</span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted-copy">No persisted conversions yet.</p>
        )}
      </section>
    </div>
  )
}

function InspectionCard({ result }: { result: ConvertTemplateResult }) {
  return (
    <div className="inspection-card">
      <div className="inspection-head">
        <div>
          <p className="panel-label">Inspection</p>
          <h3>{result.inspection.subject || '(no subject)'}</h3>
        </div>
        <span className="status-chip subtle">{result.inspection.bodyKind}</span>
      </div>
      <dl className="inspection-grid">
        <div>
          <dt>Output</dt>
          <dd>{result.outputFilename}</dd>
        </div>
        <div>
          <dt>Codepage</dt>
          <dd>{result.inspection.internetCodepage}</dd>
        </div>
        <div>
          <dt>Attachments</dt>
          <dd>{result.inspection.attachmentCount}</dd>
        </div>
        <div>
          <dt>Preview</dt>
          <dd>{result.inspection.previewText || 'No body text detected.'}</dd>
        </div>
      </dl>
      {result.inspection.attachments.length > 0 ? (
        <ul className="attachment-list">
          {result.inspection.attachments.map((attachment) => (
            <li key={`${attachment.filename}-${attachment.mimeType}`}>
              <strong>{attachment.filename}</strong>
              <span>{attachment.mimeType}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
