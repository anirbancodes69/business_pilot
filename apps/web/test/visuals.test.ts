import { describe, expect, it } from 'vitest';
import type { Answer, AnswerTable, Evidence } from '../src/lib/answer-view';
import {
  MAX_BARS,
  chartModel,
  describeEvidence,
  evidenceIndex,
  kpis,
  toCsv,
} from '../src/lib/visuals';

const ev = (
  id: string,
  row: number,
  value: number,
  display: string,
  set = 'rs1',
  column = 'dues',
): Evidence => ({
  id,
  kind: 'result',
  value,
  display,
  result: { result_set_id: set, column, row, plan_hash: 'abcdef0123456789' },
});
const table = (labels: string[], displays: string[]): AnswerTable => ({
  result_set_id: 'rs1',
  title: 'Current period',
  columns: [
    { semantic_id: 'customer.name', label: 'Customer', kind: 'dimension' },
    { semantic_id: 'dues', label: 'Dues', kind: 'measure' },
  ],
  rows: labels.map((l, i) => [l, displays[i] ?? null]),
});

describe('chart model', () => {
  const t = table(['Asha', 'Vikram', 'Meera'], ['₹9 lakh', '₹5 lakh', '₹1 lakh']);
  const evidence = [
    ev('ev_1', 0, 900000, '₹9 lakh'),
    ev('ev_2', 1, 500000, '₹5 lakh'),
    ev('ev_3', 2, 100000, '₹1 lakh'),
  ];

  it('ranks categories as bars, labelled with the server display strings', () => {
    const m = chartModel(t, evidenceIndex(evidence).byCell);
    expect(m?.kind).toBe('bars');
    expect(m?.data.map((d) => [d.label, d.display])).toEqual([
      ['Asha', '₹9 lakh'],
      ['Vikram', '₹5 lakh'],
      ['Meera', '₹1 lakh'],
    ]);
  });

  it('draws a line for dated labels with at least three points', () => {
    const dated = table(['2026-04-01', '2026-05-01', '2026-06-01'], ['₹1', '₹2', '₹3']);
    expect(chartModel(dated, evidenceIndex(evidence).byCell)?.kind).toBe('line');
    expect(
      chartModel(table(['2026-04-01', '2026-05-01'], ['₹1', '₹2']), evidenceIndex(evidence).byCell)
        ?.kind,
    ).toBe('bars');
  });

  it('offers no chart for one row, negative values, missing evidence or several dimensions', () => {
    expect(
      chartModel(table(['Asha'], ['₹9 lakh']), evidenceIndex(evidence).byCell),
    ).toBeUndefined();
    expect(
      chartModel(t, evidenceIndex([ev('ev_1', 0, -5, '-₹5'), ...evidence.slice(1)]).byCell),
    ).toBeUndefined();
    expect(chartModel(t, evidenceIndex(evidence.slice(0, 2)).byCell)).toBeUndefined();
    const two = {
      ...t,
      columns: [
        { semantic_id: 'branch.name', label: 'Branch', kind: 'dimension' as const },
        ...t.columns,
      ],
    };
    expect(chartModel(two, evidenceIndex(evidence).byCell)).toBeUndefined();
  });

  it('caps the bars and says so', () => {
    const labels = Array.from({ length: 20 }, (_, i) => `C${i}`);
    const many = table(
      labels,
      labels.map((_, i) => `₹${i}`),
    );
    const evs = labels.map((_, i) => ev(`ev_${i}`, i, 100 - i, `₹${i}`));
    const m = chartModel(many, evidenceIndex(evs).byCell);
    expect(m?.data).toHaveLength(MAX_BARS);
    expect(m?.clipped).toBe(true);
  });
});

describe('headline figures', () => {
  const cols = [{ semantic_id: 'revenue', label: 'Revenue', kind: 'measure' as const }];
  const answer: Answer = {
    status: 'answered',
    summary: 's',
    tables: [
      {
        result_set_id: 'a',
        title: 'Current period',
        period: 'current',
        columns: cols,
        rows: [['₹3.48 lakh']],
      },
      {
        result_set_id: 'b',
        title: 'Comparison period',
        period: 'comparison',
        columns: cols,
        rows: [['₹4.48 lakh']],
      },
    ],
    derived_calculations: [{ label: 'Percent change in Revenue', evidence_id: 'ev_pct' }],
    evidence: [
      ev('ev_c', 0, 348383, '₹3.48 lakh', 'a', 'revenue'),
      ev('ev_p', 0, 447733, '₹4.48 lakh', 'b', 'revenue'),
      {
        id: 'ev_pct',
        kind: 'derived',
        value: -22.19,
        display: '-22.2%',
        derived: { formula_id: 'pct_change', input_ids: ['ev_c', 'ev_p'] },
      },
    ],
  };

  it('shows the value, the other period and the direction of the change from server text', () => {
    const [k] = kpis(answer, evidenceIndex(answer.evidence ?? []).byCell);
    expect(k).toMatchObject({
      label: 'Revenue',
      display: '₹3.48 lakh',
      compare: { display: '₹4.48 lakh' },
      delta: { display: '-22.2%', direction: 'down', evidenceId: 'ev_pct' },
    });
  });

  it('gives none for grouped answers', () => {
    const grouped: Answer = { ...answer, tables: [table(['A', 'B'], ['1', '2'])] };
    expect(kpis(grouped, new Map())).toEqual([]);
  });
});

describe('csv', () => {
  it('quotes, and neutralises cells that a spreadsheet would run as formulas', () => {
    const t = table(
      ['=HYPERLINK("x")', 'Mehta, Brothers', '@cmd', '-evil'],
      ['₹1', '-₹2', '₹3', '₹4'],
    );
    const lines = toCsv(t).split('\r\n');
    expect(lines[0]).toBe('Customer,Dues');
    expect(lines[1]).toBe(`"'=HYPERLINK(""x"")",₹1`);
    expect(lines[2]).toBe('"Mehta, Brothers",-₹2');
    expect(lines[3]).toBe("'@cmd,₹3");
    expect(lines[4]).toBe("'-evil,₹4");
  });
});

describe('provenance', () => {
  const t = table(['Asha'], ['₹9 lakh']);
  const e = ev('ev_1', 0, 900000, '₹9 lakh');
  const idx = evidenceIndex([e]);
  it('describes a figure read from the data in plain language', () => {
    const p = describeEvidence(e, [t], idx.byId);
    expect(p.title).toBe('Read from your data');
    expect(p.rows).toEqual(
      expect.arrayContaining([
        { label: 'Measure', value: 'Dues' },
        { label: 'For', value: 'Asha' },
        { label: 'Query fingerprint', value: 'abcdef0123' },
      ]),
    );
  });
  it('shows the formula and the inputs of a calculation', () => {
    const d: Evidence = {
      id: 'ev_d',
      kind: 'derived',
      value: 5,
      display: '5%',
      derived: { formula_id: 'share_of_total', input_ids: ['ev_1', 'ev_x'] },
    };
    const p = describeEvidence(d, [t], idx.byId);
    expect(p.formula).toBe('Share of total = part ÷ total');
    expect(p.inputs).toEqual([{ display: '₹9 lakh', id: 'ev_1' }]);
    expect(p.title).toBe('Calculated by the system');
  });
});
