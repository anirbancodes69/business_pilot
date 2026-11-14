import type { Answer, AnswerTable, Evidence } from './answer-view';

// Pure logic for charts, KPI tiles, CSV and provenance (docs/ui/ui-standards.md). Rule: the UI never
// computes or formats a business number. Labels and values shown to people are the display strings
// the server rendered. Raw numbers (from the evidence ledger) are used only for geometry, such as a
// bar's length, and for the sign of a change.

export const cellKey = (resultSetId: string, column: string, row: number): string =>
  `${resultSetId}|${column}|${row}`;

export function evidenceIndex(evidence: Evidence[]): {
  byCell: Map<string, Evidence>;
  byId: Map<string, Evidence>;
} {
  const byCell = new Map<string, Evidence>();
  const byId = new Map<string, Evidence>();
  for (const e of evidence) {
    byId.set(e.id, e);
    if (e.result) byCell.set(cellKey(e.result.result_set_id, e.result.column, e.result.row), e);
  }
  return { byCell, byId };
}

export interface Datum {
  label: string;
  display: string;
  value: number;
  evidenceId: string;
}
export interface ChartModel {
  kind: 'bars' | 'line';
  measureLabel: string;
  data: Datum[];
  /** True when the chart shows fewer rows than the table. */
  clipped: boolean;
}

const DATE_LABEL = /^\d{4}-\d{2}(-\d{2})?$/;
export const MAX_BARS = 12;

/** One dimension plus one measure, at least two rows, no negatives. Otherwise: table only. */
export function chartModel(
  table: AnswerTable,
  byCell: Map<string, Evidence>,
): ChartModel | undefined {
  const dims = table.columns.filter((c) => c.kind === 'dimension');
  const measures = table.columns.filter((c) => c.kind === 'measure');
  if (dims.length !== 1 || measures.length < 1 || table.rows.length < 2) return undefined;
  const dimIndex = table.columns.findIndex((c) => c.kind === 'dimension');
  const measure = measures[0];
  const measureIndex = table.columns.findIndex((c) => c === measure);
  if (!measure) return undefined;
  const data: Datum[] = [];
  for (const [i, row] of table.rows.entries()) {
    const label = row[dimIndex];
    const ev = byCell.get(cellKey(table.result_set_id, measure.semantic_id, i));
    if (label == null || !ev || ev.value < 0) return undefined;
    data.push({
      label,
      display: row[measureIndex] ?? ev.display,
      value: ev.value,
      evidenceId: ev.id,
    });
  }
  const isTime = data.length >= 3 && data.every((d) => DATE_LABEL.test(d.label));
  if (isTime) return { kind: 'line', measureLabel: measure.label, data, clipped: false };
  return {
    kind: 'bars',
    measureLabel: measure.label,
    data: data.slice(0, MAX_BARS),
    clipped: data.length > MAX_BARS,
  };
}

export interface Kpi {
  label: string;
  display: string;
  evidenceId?: string;
  compare?: { display: string; evidenceId?: string };
  delta?: { display: string; direction: 'up' | 'down' | 'flat'; evidenceId: string };
}

/** Headline figures for a plain answer with no grouping, with the change against the other period. */
export function kpis(a: Answer, byCell: Map<string, Evidence>): Kpi[] {
  const tables = a.tables ?? [];
  const cur = tables.find((t) => t.period === 'current') ?? tables[0];
  if (!cur || cur.rows.length !== 1 || cur.columns.some((c) => c.kind === 'dimension')) return [];
  const prev = tables.find((t) => t.period === 'comparison');
  const derived = new Map<string, Evidence | undefined>();
  for (const c of a.derived_calculations ?? [])
    derived.set(
      c.label,
      (a.evidence ?? []).find((e) => e.id === c.evidence_id),
    );
  return cur.columns.flatMap((col, i): Kpi[] => {
    const shown = cur.rows[0]?.[i];
    if (shown == null) return [];
    const prevIndex = prev ? prev.columns.findIndex((c) => c.semantic_id === col.semantic_id) : -1;
    const prevShown = prev && prevIndex >= 0 ? prev.rows[0]?.[prevIndex] : undefined;
    const pct = derived.get(`Percent change in ${col.label}`);
    return [
      {
        label: col.label,
        display: shown,
        evidenceId: byCell.get(cellKey(cur.result_set_id, col.semantic_id, 0))?.id,
        compare:
          prev && prevShown != null
            ? {
                display: prevShown,
                evidenceId: byCell.get(cellKey(prev.result_set_id, col.semantic_id, 0))?.id,
              }
            : undefined,
        delta: pct
          ? {
              display: pct.display,
              direction: pct.value > 0 ? 'up' : pct.value < 0 ? 'down' : 'flat',
              evidenceId: pct.id,
            }
          : undefined,
      },
    ];
  });
}

/** CSV of the displayed cells. Cells that could start a spreadsheet formula are neutralised. */
export function toCsv(table: AnswerTable): string {
  const safe = (v: string | null): string => {
    let s = v ?? '';
    if (/^[=+@\t\r]/.test(s) || /^-(?![\d₹])/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [table.columns.map((c) => safe(c.label)), ...table.rows.map((r) => r.map(safe))]
    .map((r) => r.join(','))
    .join('\r\n');
}

export interface Provenance {
  title: string;
  figure: string;
  kind: Evidence['kind'];
  rows: { label: string; value: string }[];
  formula?: string;
  inputs?: { display: string; id: string }[];
}

const FORMULAS: Record<string, string> = {
  pct_change: 'Percent change = (current − previous) ÷ previous',
  abs_change: 'Change = current − previous',
  share_of_total: 'Share of total = part ÷ total',
  contribution_to_delta: 'Contribution = member change ÷ total change',
};

const short = (hash: string): string => hash.slice(0, 10);

/** Plain-language description of where one figure comes from. */
export function describeEvidence(
  ev: Evidence,
  tables: AnswerTable[],
  byId: Map<string, Evidence>,
): Provenance {
  if (ev.kind === 'result' && ev.result) {
    const r = ev.result;
    const table = tables.find((t) => t.result_set_id === r.result_set_id);
    const col = table?.columns.find((c) => c.semantic_id === r.column);
    const rowCells = table?.rows[r.row];
    const who = table?.columns
      .map((c, i) => (c.kind === 'dimension' ? rowCells?.[i] : undefined))
      .filter((v): v is string => typeof v === 'string')
      .join(' · ');
    const rows = [
      { label: 'Measure', value: col?.label ?? r.column },
      ...(who ? [{ label: 'For', value: who }] : []),
      ...(table ? [{ label: 'Period', value: table.title }] : []),
      ...(r.executed_at
        ? [{ label: 'Query ran at', value: r.executed_at.replace('T', ' ').slice(0, 16) + ' UTC' }]
        : []),
      ...(r.semantic_model_version
        ? [{ label: 'Data model version', value: String(r.semantic_model_version) }]
        : []),
      { label: 'Query fingerprint', value: short(r.plan_hash) },
    ];
    return { title: 'Read from your data', figure: ev.display, kind: ev.kind, rows };
  }
  if (ev.kind === 'derived' && ev.derived) {
    return {
      title: 'Calculated by the system',
      figure: ev.display,
      kind: ev.kind,
      rows: [{ label: 'Method', value: 'Computed in code, not by the AI model' }],
      formula: FORMULAS[ev.derived.formula_id] ?? ev.derived.formula_id,
      inputs: ev.derived.input_ids.flatMap((id) => {
        const e = byId.get(id);
        return e ? [{ display: e.display, id }] : [];
      }),
    };
  }
  return {
    title: 'A setting of your workspace',
    figure: ev.display,
    kind: ev.kind,
    rows: [{ label: 'Rule', value: ev.config?.rule_id ?? '' }],
  };
}
