import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.string().default('info'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(3002),
  AI_ENGINE_BASE_URL: z.string().url().default('http://localhost:8000'),
  POSTGRES_HOST: z.string().default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().positive().default(5432),
  POSTGRES_DB: z.string().default('businesspilot'),
  POSTGRES_APP_USER: z.string().default('bp_app'),
  POSTGRES_APP_PASSWORD: z.string().min(1),
  POSTGRES_OWNER_USER: z.string().default('bp_owner'),
  POSTGRES_OWNER_PASSWORD: z.string().optional(),
  // Authentication (D-OPEN-03). Unset = every authenticated route is rejected (fail closed).
  OIDC_ISSUER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().min(1).optional(),
  // Service trust (D-OPEN-15). Comma-separated list allows rotation with an overlap window.
  INTERNAL_SERVICE_TOKEN: z.string().min(16).optional(),
  REQUEST_CONTEXT_SIGNING_KEY: z.string().min(32).optional(),
  // Object storage adapter (ADR-0015). Only the in-memory stand-in exists until D-OPEN-24 is decided.
  OBJECT_STORAGE_DRIVER: z.enum(['dummy']).default('dummy'),
  // Connector egress guard (ADR-0004): private, loopback and link-local hosts are refused unless true.
  // For local development and tests only.
  CONNECTOR_ALLOW_PRIVATE_NETWORKS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  // Local key-encryption key for the KeyManagement port (base64, 32 bytes). Local development only.
  LOCAL_KEK_BASE64: z.string().min(1).optional(),
});

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // Empty strings (Compose) and unfilled placeholders such as <issuer-url> (.env.example) mean "unset".
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, v]) => v !== '' && !/^<[^>]*>$/.test(v ?? '')),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    // Report variable names only, never values.
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration: ${names}`);
  }
  return parsed.data;
}
