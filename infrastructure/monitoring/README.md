# infrastructure/monitoring

**Status: minimal.** Milestone 1 uses the optional `grafana/otel-lgtm` container (Compose profile `observability`, Grafana on 127.0.0.1:3100). No dashboards yet. Planned: OpenTelemetry collector plus a Grafana stack (metrics, logs, traces) for local development and customer-hosted deployments. Dashboards planned: request latency per pipeline stage, LLM tokens and cost per tenant, cache hit rates, sync freshness and failures, isolation test status. Telemetry must not contain credentials, result rows or prompt or answer text.
