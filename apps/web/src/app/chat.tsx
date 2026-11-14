'use client';

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QuestionResponse } from '../lib/answer-view';
import { S } from '../lib/strings';
import { evidenceIndex } from '../lib/visuals';
import { AnswerCard, AnswerSkeleton } from '../components/answer-card';
import { EvidenceDrawer } from '../components/evidence-drawer';
import { IconClose, IconMenu, IconPlus, IconSend, Logo } from '../components/icons';

interface Turn {
  id: number;
  question: string;
  response?: QuestionResponse;
  error?: string;
  pending?: boolean;
}

const MAX = 1000;

export function Chat({ tenantName }: { tenantName: string | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [nav, setNav] = useState(false);
  const [open, setOpen] = useState<{ turn: number; evidenceId: string } | undefined>();
  const conversation = useRef<string | undefined>(undefined);
  const nextId = useRef(1);
  const area = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    end.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'end' });
  }, [turns]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const ask = useCallback(
    async (raw: string) => {
      const question = raw.trim();
      if (!question || busy) return;
      const id = nextId.current++;
      setBusy(true);
      setText('');
      setNav(false);
      setTurns((t) => [...t, { id, question, pending: true }]);
      let patch: Partial<Turn>;
      try {
        const res = await fetch('/api/questions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ question, conversation_id: conversation.current }),
        });
        if (res.ok) {
          const data = (await res.json()) as QuestionResponse;
          conversation.current = data.conversation_id;
          patch = { response: data };
        } else {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          patch = { error: body.error ?? 'failed' };
        }
      } catch {
        patch = { error: 'unavailable' };
      }
      setTurns((t) => t.map((x) => (x.id === id ? { ...x, ...patch, pending: false } : x)));
      setBusy(false);
      area.current?.focus();
    },
    [busy],
  );

  function submit(e: FormEvent): void {
    e.preventDefault();
    void ask(text);
  }

  function reset(): void {
    setTurns([]);
    setOpen(undefined);
    conversation.current = undefined;
    setNav(false);
    area.current?.focus();
  }

  const drawer = useMemo(() => {
    const t = turns.find((x) => x.id === open?.turn);
    const a = t?.response?.answer;
    if (!open || !a) return undefined;
    const idx = evidenceIndex(a.evidence ?? []);
    const ev = idx.byId.get(open.evidenceId);
    return ev ? { ev, tables: a.tables ?? [], byId: idx.byId } : undefined;
  }, [open, turns]);

  const left = MAX - text.length;

  return (
    <div className="app">
      <aside className={`sidebar${nav ? ' open' : ''}`} aria-label="Navigation">
        <div className="side-top">
          <div className="brand">
            <Logo />
            <span>{S.appName}</span>
          </div>
          <button
            type="button"
            className="icon-btn side-close"
            onClick={() => setNav(false)}
            aria-label={S.close}
          >
            <IconClose />
          </button>
        </div>
        <button type="button" className="new" onClick={reset}>
          <IconPlus />
          {S.newChat}
        </button>
        <nav className="history" aria-label={S.thisSession}>
          <p className="eyebrow">{S.thisSession}</p>
          {turns.length === 0 ? (
            <p className="muted small">{S.emptySession}</p>
          ) : (
            <ul>
              {turns.map((t) => (
                <li key={t.id}>
                  <a href={`#turn-${t.id}`} onClick={() => setNav(false)} title={t.question}>
                    {t.question}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </nav>
        <div className="side-foot">
          <div className="workspace">
            <span className="avatar" aria-hidden="true">
              {(tenantName ?? '?').slice(0, 1).toUpperCase()}
            </span>
            <span className="ws-text">
              <span className="ws-label">{S.workspace}</span>
              <span className="ws-name">{tenantName ?? '—'}</span>
            </span>
          </div>
          <form action="/logout" method="post">
            <button type="submit" className="ghost full">
              {S.signOut}
            </button>
          </form>
        </div>
      </aside>
      {nav && <div className="nav-scrim" onClick={() => setNav(false)} />}

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="icon-btn"
            onClick={() => setNav(true)}
            aria-label={S.menu}
          >
            <IconMenu />
          </button>
          <span className="brand sm">
            <Logo size={22} />
            {S.appName}
          </span>
        </header>

        <main id="main" className="scroll">
          <div className="column">
            {turns.length === 0 ? (
              <section className="empty">
                <Logo size={44} />
                <h1>{S.emptyTitle(tenantName)}</h1>
                <p>{S.emptyHint}</p>
                <p className="eyebrow">{S.suggestionsTitle}</p>
                <ul className="suggest">
                  {S.suggestions.map((q) => (
                    <li key={q}>
                      <button type="button" onClick={() => void ask(q)} disabled={busy}>
                        {q}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <div className="thread" aria-live="polite">
                {turns.map((t) => (
                  <article key={t.id} id={`turn-${t.id}`} className="turn">
                    <h2 className="question">{t.question}</h2>
                    {t.pending ? (
                      <AnswerSkeleton />
                    ) : t.error ? (
                      <p role="alert" className="banner warning">
                        {S.errors[t.error] ?? S.errors.failed}{' '}
                        {t.error === 'session_expired' && <a href="/login">{S.signIn}</a>}
                      </p>
                    ) : (
                      t.response && (
                        <AnswerCard
                          question={t.question}
                          response={t.response}
                          onEvidence={(evidenceId) => setOpen({ turn: t.id, evidenceId })}
                        />
                      )
                    )}
                  </article>
                ))}
              </div>
            )}
            <div ref={end} />
          </div>
        </main>

        <div className="composer-wrap">
          <form onSubmit={submit} className="composer">
            <label htmlFor="q" className="sr-only">
              {S.ask}
            </label>
            <textarea
              id="q"
              ref={area}
              value={text}
              maxLength={MAX}
              rows={1}
              placeholder={S.askPlaceholder}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <button
              type="submit"
              className="send"
              disabled={busy || !text.trim()}
              aria-label={S.ask}
            >
              <IconSend />
            </button>
          </form>
          <p className="composer-hint">{left <= 200 ? S.charsLeft(left) : S.composerHint}</p>
        </div>
      </div>

      {drawer && open && (
        <EvidenceDrawer
          evidence={drawer.ev}
          tables={drawer.tables}
          byId={drawer.byId}
          onClose={() => setOpen(undefined)}
          onOpen={(evidenceId) => setOpen({ turn: open.turn, evidenceId })}
        />
      )}
    </div>
  );
}
