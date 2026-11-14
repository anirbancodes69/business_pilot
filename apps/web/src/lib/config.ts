// Web server configuration. Read from the environment of the web server only (never sent to the
// browser). Sign-in fails closed when anything required is missing.

export interface WebConfig {
  /** Public origin of this web app, for redirects and the Origin check. */
  baseUrl: string;
  /** Issuer as the browser sees it (used to start the sign-in). */
  issuerPublic: string;
  /** Issuer URL the web server can reach (token calls). Same as the public one unless in a container. */
  issuerInternal: string;
  clientId: string;
  apiBaseUrl: string;
  sessionSecret: string;
}

export class ConfigError extends Error {}

export function loadConfig(env: Record<string, string | undefined> = process.env): WebConfig {
  const need = (name: string): string => {
    const v = env[name]?.trim();
    if (!v || v.startsWith('<')) throw new ConfigError(`${name} is not set`);
    return v;
  };
  const secret = need('WEB_SESSION_SECRET');
  if (secret.length < 32)
    throw new ConfigError('WEB_SESSION_SECRET must be at least 32 characters');
  const issuerPublic = need('OIDC_ISSUER_URL').replace(/\/$/, '');
  return {
    baseUrl: (env.WEB_BASE_URL?.trim() || 'http://localhost:3000').replace(/\/$/, ''),
    issuerPublic,
    issuerInternal: (env.OIDC_INTERNAL_URL?.trim() || issuerPublic).replace(/\/$/, ''),
    clientId: need('OIDC_CLIENT_ID'),
    apiBaseUrl: need('API_BASE_URL').replace(/\/$/, ''),
    sessionSecret: secret,
  };
}
