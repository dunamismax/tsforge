import { type Span, SpanStatusCode, trace } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { NodeSDK } from '@opentelemetry/sdk-node'
import { ConsoleSpanExporter } from '@opentelemetry/sdk-trace-base'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'

declare global {
  var __tsforgeObservability: Promise<void> | undefined
}

const serviceName = 'tsforge'

const createSdk = () => {
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  return new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    traceExporter: endpoint ? new OTLPTraceExporter({ url: endpoint }) : new ConsoleSpanExporter(),
  })
}

export const initializeObservability = () => {
  if (!globalThis.__tsforgeObservability) {
    const sdk = createSdk()
    globalThis.__tsforgeObservability = Promise.resolve(sdk.start()).then(() => undefined)
  }
  return globalThis.__tsforgeObservability
}

export const withServerSpan = async <T>(name: string, run: (span: Span) => Promise<T>) => {
  await initializeObservability()
  const tracer = trace.getTracer(serviceName)
  return tracer.startActiveSpan(name, async (span) => {
    try {
      const value = await run(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return value
    } catch (error) {
      span.recordException(error instanceof Error ? error : new Error(String(error)))
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      })
      throw error
    } finally {
      span.end()
    }
  })
}
