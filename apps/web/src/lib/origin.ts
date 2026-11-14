import type { WebConfig } from './config';

/** Same-origin check for requests that change state (on top of SameSite cookies). */
export function sameOrigin(req: Request, cfg: Pick<WebConfig, 'baseUrl'>): boolean {
  const origin = req.headers.get('origin');
  return origin !== null && origin === new URL(cfg.baseUrl).origin;
}
