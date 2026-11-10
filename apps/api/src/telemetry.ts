import { startTelemetry } from './platform/telemetry/telemetry';

startTelemetry(process.env.OTEL_SERVICE_NAME ?? 'bp-api');
