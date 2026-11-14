'use client';

import { type FormEvent, useRef, useState } from 'react';
import { type AnswerTable, type QuestionResponse, buildAnswerView } from '../lib/answer-view';
import { S } from '../lib/strings';

interface Turn {
  question: string;
  response?: QuestionResponse;
  error?: string;
}

export function Chat() {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const conversation = useRef<string | undefined>(undefined);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const question = text.trim();
    if (!question || busy) return;
    setBusy(true);
    setText('');
    let turn: Turn = { question };
    try {
      const res = await fetch('/api/questions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question, conversation_id: conversation.current }),
      });
      if (res.ok) {
        const data = (await res.json()) as QuestionResponse;
        conversation.current = data.conversation_id;
        turn = { question, response: data };
      } else {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        turn = { question, error: body.error ?? 'failed' };
      }
    } catch {
      turn = { question, error: 'unavailable' };
    }
    setTurns((t) => [...t, turn]);
    setBusy(false);
  }

  return (
    <>
      <div aria-live="polite" className="thread">
        {turns.map((t, i) => (
          <article key={i} className="turn">
            <h2 className="question">{t.question}</h2>
            {t.error ? (
              <p role="alert" className="banner warning">
                {S.errors[t.error] ?? S.errors.failed}{' '}
                {t.error === 'session_expired' && <a href="/login">{S.signIn}</a>}
              </p>
            ) : (
              t.response && <Answer response={t.response} />
            )}
          </article>
        ))}
        {busy && <p className="muted">{S.asking}</p>}
      </div>
      <form onSubmit={submit} className="ask">
        <label htmlFor="q" className="sr-only">
          {S.ask}
        </label>
        <textarea
          id="q"
          value={text}
          maxLength={1000}
          rows={2}
          placeholder={S.askPlaceholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" className="button" disabled={busy || !text.trim()}>
          {S.ask}
        </button>
      </form>
    </>
  );
}

function Answer({ response }: { response: QuestionResponse }) {
  const v = buildAnswerView(response.answer);
  return (
    <div className="answer">
      {v.banner && <p className={`banner ${v.banner.tone}`}>{v.banner.text}</p>}
      <p className="summary">{v.summary}</p>
      {v.clarification && <p className="clarify">{v.clarification}</p>}
      {v.tables.map((t) => (
        <ResultTable key={t.result_set_id} table={t} />
      ))}
      {v.sections.map((s) => (
        <section key={s.key} className={`section ${s.key}`}>
          <h3>{s.title}</h3>
          {s.note && <p className="note">{s.note}</p>}
          <ul>
            {s.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ))}
      {v.asOf && (
        <p className="muted">
          {S.dataAsOf} {v.asOf}
        </p>
      )}
    </div>
  );
}

function ResultTable({ table }: { table: AnswerTable }) {
  return (
    <div className="tablewrap">
      <table>
        <caption>{table.title}</caption>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th
                key={c.semantic_id}
                scope="col"
                className={c.kind === 'measure' ? 'num' : undefined}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} className={table.columns[j]?.kind === 'measure' ? 'num' : undefined}>
                  {cell ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.truncated && <p className="muted">{S.truncated}</p>}
    </div>
  );
}
