import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { registerInstrumentations } from '@opentelemetry/instrumentation';

/**
 * Starts tracing. Must run before `http` is first required by the application
 * (import it first in each entrypoint). Exporter is chosen by env:
 *  - OTEL_TRACES_EXPORTER=console  -> print spans (local debugging, tests)
 *  - OTEL_TRACES_EXPORTER=none     -> no export
 *  - otherwise OTLP/HTTP to OTEL_EXPORTER_OTLP_ENDPOINT
 * Span attributes must not contain credentials, result rows or tenant prompt content.
 */
export function startTelemetry(serviceName: string): NodeTracerProvider {
  const mode = process.env.OTEL_TRACES_EXPORTER ?? 'otlp';
  const processors =
    mode === 'none'
      ? []
      : mode === 'console'
        ? [new SimpleSpanProcessor(new ConsoleSpanExporter())]
        : [new BatchSpanProcessor(new OTLPTraceExporter())];
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }),
    spanProcessors: processors,
  });
  provider.register(); // also installs the W3C trace-context propagator
  registerInstrumentations({ instrumentations: [new HttpInstrumentation()] });
  return provider;
}
