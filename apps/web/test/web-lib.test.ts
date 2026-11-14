import { describe, expect, it } from 'vitest';
import { buildAnswerView, asOfText, sourceLines } from '../src/lib/answer-view';
import { ConfigError, loadConfig } from '../src/lib/config';
import { newPkce, authorizeUrl } from '../src/lib/oidc';
import { sameOrigin } from '../src/lib/origin';
import {
  type CookieJar,
  type Session,
  clearSession,
  readSession,
  seal,
  unseal,
  writeSession,
} from '../src/lib/session';

const SECRET = 's'.repeat(40);
const session: Session = {
  accessToken: 'a'.repeat(1500),
  refreshToken: 'r'.repeat(900),
  expiresAt: 1_800_000_000_000,
  tenantId: '01a6d030-3421-4085-bb15-4b56b3f4a101',
  tenantName: 'Demo',
};

function jar(): CookieJar & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: (n) => (store.has(n) ? { value: store.get(n) as string } : undefined),
    set: (n, v) => void store.set(n, v),
    delete: (n) => void store.delete(n),
  };
}

describe('sealed session', () => {
  it('round-trips and never shows the tokens in the cookie value', () => {
    const sealed = seal(session, SECRET);
    expect(sealed).not.toContain('aaaa');
    expect(unseal<Session>(sealed, SECRET)).toEqual(session);
  });

  it('refuses a wrong key, a changed value and garbage', () => {
    const sealed = seal(session, SECRET);
    expect(unseal(sealed, 'x'.repeat(40))).toBeUndefined();
    const flipped = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(unseal(flipped, SECRET)).toBeUndefined();
    expect(unseal('nonsense', SECRET)).toBeUndefined();
    expect(unseal('', SECRET)).toBeUndefined();
  });

  it('splits a large session over several cookies, each under the size limit, and reads it back', () => {
    const j = jar();
    writeSession(j, session, SECRET, false);
    expect(j.store.size).toBeGreaterThan(1);
    for (const v of j.store.values()) expect(v.length).toBeLessThan(3600);
    expect(readSession(j, SECRET)).toEqual(session);
    clearSession(j);
    expect(readSession(j, SECRET)).toBeUndefined();
  });

  it('a session written with another secret is not readable (secret rotation logs users out)', () => {
    const j = jar();
    writeSession(j, session, SECRET, false);
    expect(readSession(j, 'y'.repeat(40))).toBeUndefined();
  });
});

describe('configuration and sign-in', () => {
  const env = {
    WEB_SESSION_SECRET: SECRET,
    OIDC_ISSUER_URL: 'http://localhost:8080/realms/businesspilot/',
    OIDC_CLIENT_ID: 'businesspilot',
    API_BASE_URL: 'http://api:3001',
  };

  it('fails closed on a missing, placeholder or short secret', () => {
    expect(() => loadConfig({ ...env, WEB_SESSION_SECRET: undefined })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, WEB_SESSION_SECRET: '<generate-locally>' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...env, WEB_SESSION_SECRET: 'short' })).toThrow(/32/);
    expect(() => loadConfig({ ...env, OIDC_CLIENT_ID: '' })).toThrow(ConfigError);
  });

  it('builds a PKCE authorization URL with S256 and a state', () => {
    const cfg = loadConfig(env);
    const p = newPkce();
    const url = new URL(authorizeUrl(cfg, p.state, p.challenge));
    expect(url.origin + url.pathname).toBe(
      'http://localhost:8080/realms/businesspilot/protocol/openid-connect/auth',
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(p.challenge);
    expect(url.searchParams.get('state')).toBe(p.state);
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/callback');
    expect(p.verifier).not.toBe(p.challenge);
    expect(newPkce().state).not.toBe(p.state);
  });

  it('accepts only requests from the web origin', () => {
    const cfg = { baseUrl: 'http://localhost:3000' };
    const req = (origin?: string) =>
      new Request('http://localhost:3000/api/questions', {
        method: 'POST',
        headers: origin ? { origin } : {},
      });
    expect(sameOrigin(req('http://localhost:3000'), cfg)).toBe(true);
    expect(sameOrigin(req('https://evil.example'), cfg)).toBe(false);
    expect(sameOrigin(req(), cfg)).toBe(false);
  });
});

describe('answer view', () => {
  const base = { status: 'answered', summary: 'Shree Mart owes the most.' };

  it('orders the sections, hides empty ones and labels hypotheses', () => {
    const v = buildAnswerView({
      ...base,
      verified_facts: [{ statement: 'Shree Mart: ₹1.96 lakh' }],
      derived_calculations: [{ label: 'Change in Revenue', evidence_id: 'ev_1' }],
      possible_explanations: [{ text: 'Terms may differ.' }],
      unknowns: ['Credit limits are not in this data.'],
      evidence: [{ id: 'ev_1', kind: 'derived', value: -99350, display: '-₹99,350' }],
    });
    expect(v.sections.map((s) => s.key)).toEqual([
      'facts',
      'calculations',
      'explanations',
      'unknowns',
    ]);
    expect(v.sections[1]?.items).toEqual(['Change in Revenue: -₹99,350']);
    expect(v.sections[2]?.note).toMatch(/not verified/i);
    expect(v.sections[0]?.note).toBeUndefined();
  });

  it('shows suggested next steps after the hypotheses, separate from verified facts', () => {
    const v = buildAnswerView({
      ...base,
      verified_facts: [{ statement: 'Nashik: -₹1.48 lakh' }],
      possible_explanations: [{ text: 'A promotion may have ended.' }],
      recommendations: [{ text: 'Branch: Nashik accounts for 71.7% of the decline.' }],
    });
    expect(v.sections.map((s) => s.key)).toEqual(['facts', 'explanations', 'recommendations']);
    expect(v.sections[2]?.title).toBe('Suggested next steps');
    expect(v.sections[2]?.note).toBeUndefined();
  });

  it('says plainly when an answer is degraded, not authorized or out of scope', () => {
    expect(buildAnswerView({ ...base, status: 'answered_facts_only' }).banner).toEqual({
      tone: 'warning',
      text: 'Explanation unavailable. Showing the results only.',
    });
    expect(buildAnswerView({ ...base, status: 'not_authorized' }).banner?.text).toMatch(/access/);
    expect(buildAnswerView({ ...base, status: 'answered' }).banner).toBeUndefined();
  });

  it('shows the clarification question only for clarification answers', () => {
    const q = { ...base, clarification_question: 'Which period?' };
    expect(buildAnswerView({ ...q, status: 'clarification_needed' }).clarification).toBe(
      'Which period?',
    );
    expect(buildAnswerView({ ...q, status: 'answered' }).clarification).toBeUndefined();
  });

  it('keeps table cells exactly as given and drops empty tables', () => {
    const table = {
      result_set_id: 'r1',
      title: 'Current period',
      as_of: '2026-11-15T04:30:12Z',
      columns: [{ semantic_id: 'customer.name', label: 'Customer', kind: 'dimension' as const }],
      rows: [['Asha Traders']],
    };
    const v = buildAnswerView({
      ...base,
      tables: [table, { ...table, result_set_id: 'r2', rows: [] }],
    });
    expect(v.tables).toHaveLength(1);
    expect(v.tables[0]?.rows).toEqual([['Asha Traders']]);
    expect(v.asOf).toBe('2026-11-15 04:30 UTC');
    expect(asOfText('garbage')).toBeUndefined();
  });
});

describe('sources', () => {
  const base = { status: 'answered', summary: 's' };
  it('names each source with what was read and when it last synced', () => {
    const lines = sourceLines({
      ...base,
      sources: [
        { data_source_id: 'a', data_source_name: 'Tally export', entity: 'invoice' },
        { data_source_id: 'a', data_source_name: 'Tally export', entity: 'customer' },
      ],
      freshness: [
        { dataset_id: 'x', as_of: '2026-11-15T02:30:00Z' },
        { dataset_id: 'y', as_of: '2026-11-15T04:10:00Z' },
      ],
    });
    expect(lines).toEqual([
      { text: 'Tally export · Invoices, Customers · synced 2026-11-15 02:30 UTC', stale: false },
    ]);
  });

  it('flags stale data and shows nothing when there is no source information', () => {
    const stale = sourceLines({
      ...base,
      sources: [{ data_source_id: 'a', entity: 'invoice' }],
      freshness: [{ dataset_id: 'x', as_of: '2026-11-10T00:00:00Z', stale: true }],
    });
    expect(stale[0]?.stale).toBe(true);
    expect(sourceLines(base)).toEqual([]);
  });
});
