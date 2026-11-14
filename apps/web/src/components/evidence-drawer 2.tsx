'use client';

import { useEffect, useRef } from 'react';
import type { AnswerTable, Evidence } from '../lib/answer-view';
import { S } from '../lib/strings';
import { describeEvidence } from '../lib/visuals';
import { IconClose } from './icons';

/** Where one figure comes from, in plain language. Opens from any figure; Escape closes it. */
export function EvidenceDrawer({
  evidence,
  tables,
  byId,
  onClose,
  onOpen,
}: {
  evidence: Evidence;
  tables: AnswerTable[];
  byId: Map<string, Evidence>;
  onClose: () => void;
  onOpen: (id: string) => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const p = describeEvidence(evidence, tables, byId);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <div>
            <p className="eyebrow" id="drawer-title">
              {S.provenance.title}
            </p>
            <p className="drawer-figure">{p.figure}</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label={S.close}
          >
            <IconClose />
          </button>
        </header>
        <p className="drawer-kind">{p.title}</p>
        <dl>
          {p.rows.map((r) => (
            <div key={r.label} className="kv">
              <dt>{r.label}</dt>
              <dd>{r.value}</dd>
            </div>
          ))}
        </dl>
        {p.formula && (
          <section>
            <h4>{S.provenance.formula}</h4>
            <p className="formula">{p.formula}</p>
          </section>
        )}
        {p.inputs && p.inputs.length > 0 && (
          <section>
            <h4>{S.provenance.inputs}</h4>
            <ul className="inputs">
              {p.inputs.map((i) => (
                <li key={i.id}>
                  <button type="button" className="link" onClick={() => onOpen(i.id)}>
                    {i.display}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="note">{S.provenance.footer}</p>
      </aside>
    </div>
  );
}
