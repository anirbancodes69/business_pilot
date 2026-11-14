'use client';

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { QuestionResponse } from '../lib/answer-view';
import {
  type ConversationSummary,
  type StoredTurn,
  dayLabel,
  groupConversations,
  storedToResponse,
} from '../lib/history';
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
  /** Set for a turn reopened from the history: when it was answered. */
  answeredAt?: string;
}

const MAX = 1000;

export function Chat({ tenantName }: { tenantName: string | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [nav, setNav] = useState(false);
  const [open, setOpen] = useState<{ turn: number; evidenceId: string } | undefined>();
  const [history, setHistory] = useState<ConversationSummary[] | undefined>();
  const [historyFailed, setHistoryFailed] = useState(false);
  const [active, setActive] = useState<string | undefined>();
  const [loadingId, setLoadingId] = useState<string | undefined>();
  const [confirming, setConfirming] = useState<string | undefined>();
  const conversation = useRef<string | undefined>(undefined);
  const nextId = useRef(1);
  const area = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);

  const refreshHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations', { cache: 'no-store' });
      if (!res.ok) throw new Error('failed');
      setHistory(((await res.json()) as { conversations: ConversationSummary[] }).conversations);
      setHistoryFailed(false);
    } catch {
      setHistoryFailed(true);
    }
  }, []);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

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
          setActive(data.conversation_id);
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
      void refreshHistory();
    },
    [busy, refreshHistory],
  );

  function submit(e: FormEvent): void {
    e.preventDefault();
    void ask(text);
  }

  function reset(): void {
    setTurns([]);
    setOpen(undefined);
    conversation.current = undefined;
    setActive(undefined);
    setConfirming(undefined);
    setNav(false);
    area.current?.focus();
  }

  async function openConversation(id: string): Promise<void> {
    if (busy || loadingId) return;
    setLoadingId(id);
    setNav(false);
    try {
      const res = await fetch(`/api/conversations/${id}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('failed');
      const data = (await res.json()) as { conversation_id: string; turns: StoredTurn[] };
      setOpen(undefined);
      conversation.current = data.conversation_id;
      setActive(data.conversation_id);
      setTurns(
        data.turns.map((t) => {
          const response = storedToResponse(data.conversation_id, t);
          return {
            id: nextId.current++,
            question: t.question ?? '',
            response,
            error: response ? undefined : 'answer_not_kept',
            answeredAt: t.created_at,
          };
        }),
      );
    } catch {
      setHistoryFailed(true);
    } finally {
      setLoadingId(undefined);
    }
  }

  async function deleteConversation(id: string): Promise<void> {
    setConfirming(undefined);
    try {
      const res = await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
      if (res.status !== 204 && res.status !== 404) throw new Error('failed');
      if (id === active) reset();
      await refreshHistory();
    } catch {
      setHistoryFailed(true);
    }
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
        <nav className="history" aria-label={S.conversations}>
          {historyFailed && (
            <p role="alert" className="muted small">
              {S.historyError}
            </p>
          )}
          {history === undefined ? null : history.length === 0 ? (
            <p className="muted small">{S.noHistory}</p>
          ) : (
            groupConversations(history, new Date()).map((g) => (
              <section key={g.label}>
                <p className="eyebrow">{g.label}</p>
                <ul>
                  {g.items.map((c) => (
                    <li key={c.id} className={c.id === active ? 'current' : undefined}>
                      {confirming === c.id ? (
                        <span className="confirm" role="group" aria-label={S.confirmDelete}>
                          <span>{S.confirmDelete}</span>
                          <button
                            type="button"
                            className="link danger"
                            onClick={() => void deleteConversation(c.id)}
                          >
                            {S.yes}
                          </button>
                          <button
                            type="button"
                            className="link"
                            onClick={() => setConfirming(undefined)}
                          >
                            {S.cancel}
                          </button>
                        </span>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="conv"
                            onClick={() => void openConversation(c.id)}
                            title={c.title}
                            aria-current={c.id === active ? 'true' : undefined}
                            disabled={loadingId === c.id}
                          >
                            {c.title}
                          </button>
                          <button
                            type="button"
                            className="icon-btn del"
                            onClick={() => setConfirming(c.id)}
                            aria-label={`${S.deleteConversation}: ${c.title}`}
                          >
                            <IconClose />
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))
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
                    {t.answeredAt && (
                      <p className="muted small answered-on">
                        {S.answeredOn} {dayLabel(t.answeredAt, new Date())}
                      </p>
                    )}
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
