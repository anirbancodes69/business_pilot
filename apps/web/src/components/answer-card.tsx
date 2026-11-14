'use client';

import { useId, useMemo, useState } from 'react';
import { type QuestionResponse, buildAnswerView, sourceLines } from '../lib/answer-view';
import { S } from '../lib/strings';
import { chartModel, evidenceIndex, kpis, toCsv } from '../lib/visuals';
import { BarChart, LineChart } from './charts';
import {
  IconAlert,
  IconArrow,
  IconChart,
  IconCheck,
  IconCopy,
  IconDownload,
  IconInfo,
  IconShield,
  IconTable,
} from './icons';

type View = 'chart' | 'table';

function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'answer'
  );
}

export function AnswerCard({
  question,
  response,
  onEvidence,
}: {
  question: string;
  response: QuestionResponse;
  onEvidence: (evidenceId: string) => void;
}) {
  const a = response.answer;
  const v = useMemo(() => buildAnswerView(a), [a]);
  const idx = useMemo(() => evidenceIndex(a.evidence ?? []), [a.evidence]);
  const sourceLinesOf = useMemo(() => sourceLines(a), [a]);
  const headline = useMemo(() => kpis(a, idx.byCell), [a, idx]);
  const primary = v.tables.find((t) => t.period !== 'comparison') ?? v.tables[0];
  const chart = useMemo(
    () => (primary ? chartModel(primary, idx.byCell) : undefined),
    [primary, idx],
  );
  const [view, setView] = useState<View>(chart ? 'chart' : 'table');
  const [copied, setCopied] = useState(false);
  const tabsId = useId();

  const okStatus = a.status === 'answered';
  const badge = okStatus
    ? { tone: 'ok', icon: <IconShield />, text: S.badge.verified }
    : a.status === 'answered_facts_only'
      ? { tone: 'warn', icon: <IconAlert />, text: S.badge.factsOnly }
      : { tone: 'info', icon: <IconInfo />, text: S.status[a.status] ?? S.badge.info };

  async function copy(): Promise<void> {
    const text = [a.summary, ...(a.verified_facts ?? []).map((f) => `• ${f.statement}`)].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable: nothing to report */
    }
  }

  function download(): void {
    if (!primary) return;
    const url = URL.createObjectURL(
      new Blob(['\uFEFF' + toCsv(primary)], { type: 'text/csv;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `businesspilot-${slug(question)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="answer" aria-busy="false">
      <div className="answer-head">
        <span className={`badge ${badge.tone}`}>
          {badge.icon}
          {badge.text}
        </span>
        {v.asOf && (
          <span className="asof">
            {S.dataAsOf} {v.asOf}
          </span>
        )}
      </div>

      {a.interpretation && (
        <p className="interpretation">
          <span>{S.showing}</span> {a.interpretation}
        </p>
      )}
      <p className="headline">{v.summary}</p>
      {v.clarification && <p className="clarify">{v.clarification}</p>}

      {headline.length > 0 && (
        <div className="kpis">
          {headline.map((k) => (
            <button
              type="button"
              key={k.label}
              className="kpi"
              onClick={() => k.evidenceId && onEvidence(k.evidenceId)}
              disabled={!k.evidenceId}
            >
              <span className="kpi-label">{k.label}</span>
              <span className="kpi-value">{k.display}</span>
              {k.compare && (
                <span className="kpi-compare">
                  {S.previousPeriod}: {k.compare.display}
                </span>
              )}
              {k.delta && (
                <span className={`delta ${k.delta.direction}`}>
                  <IconArrow dir={k.delta.direction} />
                  {k.delta.display}
                </span>
              )}
            </button>
          ))}
        </div>
      )}

      {primary && headline.length === 0 && (
        <section className="viz" aria-label={primary.title}>
          <div className="viz-head">
            <h3>{chart ? chart.measureLabel : primary.title}</h3>
            {chart && (
              <div role="tablist" aria-label="View" className="seg">
                {(['chart', 'table'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    id={`${tabsId}-${t}`}
                    aria-selected={view === t}
                    aria-controls={`${tabsId}-panel`}
                    tabIndex={view === t ? 0 : -1}
                    className={view === t ? 'on' : undefined}
                    onClick={() => setView(t)}
                    onKeyDown={(e) => {
                      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft')
                        setView(view === 'chart' ? 'table' : 'chart');
                    }}
                  >
                    {t === 'chart' ? <IconChart /> : <IconTable />}
                    {t === 'chart' ? S.viewChart : S.viewTable}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div
            id={`${tabsId}-panel`}
            role={chart ? 'tabpanel' : undefined}
            aria-labelledby={chart ? `${tabsId}-${view}` : undefined}
          >
            {chart && view === 'chart' ? (
              chart.kind === 'line' ? (
                <LineChart model={chart} onSelect={onEvidence} />
              ) : (
                <BarChart model={chart} onSelect={onEvidence} />
              )
            ) : (
              v.tables.map((t) => (
                <div className="tablewrap" key={t.result_set_id}>
                  <table>
                    <caption>{t.title}</caption>
                    <thead>
                      <tr>
                        {t.columns.map((c) => (
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
                      {t.rows.map((row, i) => (
                        <tr key={i}>
                          {row.map((cell, j) => {
                            const col = t.columns[j];
                            const evidenceId =
                              t.cell_evidence?.[i]?.[j] ??
                              (col?.kind === 'measure'
                                ? idx.byCell.get(`${t.result_set_id}|${col.semantic_id}|${i}`)?.id
                                : undefined);
                            const ev = evidenceId ? idx.byId.get(evidenceId) : undefined;
                            return (
                              <td key={j} className={col?.kind === 'measure' ? 'num' : undefined}>
                                {ev && cell != null ? (
                                  <button
                                    type="button"
                                    className="figure"
                                    onClick={() => onEvidence(ev.id)}
                                    title={S.showSource}
                                  >
                                    {cell}
                                  </button>
                                ) : (
                                  (cell ?? '—')
                                )}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {t.truncated && <p className="muted">{S.truncated}</p>}
                </div>
              ))
            )}
            {chart?.clipped && view === 'chart' && <p className="muted">{S.chartClipped}</p>}
          </div>
        </section>
      )}

      {v.sections.map((s) => (
        <section key={s.key} className={`block ${s.key}`}>
          <h3>{s.title}</h3>
          {s.note && <p className="note">{s.note}</p>}
          <ul>
            {s.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </section>
      ))}

      {sourceLinesOf.length > 0 && (
        <div className="sources">
          <span className="eyebrow">{S.sources}</span>
          <ul>
            {sourceLinesOf.map((s) => (
              <li key={s.text}>
                {s.text}
                {s.stale && <span className="badge warn"> {S.staleData}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="actions">
        <button type="button" className="ghost" onClick={copy}>
          {copied ? <IconCheck /> : <IconCopy />}
          {copied ? S.copied : S.copy}
        </button>
        {primary && (
          <button type="button" className="ghost" onClick={download}>
            <IconDownload />
            {S.downloadCsv}
          </button>
        )}
        <span className="hint">{S.sourceHint}</span>
      </div>
    </div>
  );
}

export function AnswerSkeleton() {
  return (
    <div className="answer skeleton" aria-busy="true" aria-live="polite">
      <span className="sr-only">{S.asking}</span>
      <div className="sk line w30" />
      <div className="sk line w80" />
      <div className="sk line w60" />
      <div className="sk block" />
    </div>
  );
}
