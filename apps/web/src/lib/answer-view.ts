import { S } from './strings';

// What an answer shows, decided in one pure place (docs/ui/ui-standards.md §3). No number is
// computed or formatted here: every figure is text that the server already rendered.

export interface Evidence {
  id: string;
  display: string;
}
export interface AnswerTable {
  result_set_id: string;
  title: string;
  period?: 'current' | 'comparison';
  as_of?: string;
  truncated?: boolean;
  columns: { semantic_id: string; label: string; kind: 'dimension' | 'measure' }[];
  rows: (string | null)[][];
}
export interface Answer {
  status: string;
  summary: string;
  verified_facts?: { statement: string }[];
  derived_calculations?: { label: string; evidence_id: string }[];
  possible_explanations?: { text: string }[];
  recommendations?: { text: string }[];
  unknowns?: string[];
  clarification_question?: string;
  tables?: AnswerTable[];
  evidence?: Evidence[];
}
export interface QuestionResponse {
  conversation_id: string;
  turn: number;
  answer: Answer;
}

export interface Section {
  key: 'facts' | 'calculations' | 'explanations' | 'recommendations' | 'unknowns';
  title: string;
  items: string[];
  note?: string;
}
export interface AnswerView {
  banner?: { tone: 'info' | 'warning'; text: string };
  summary: string;
  clarification?: string;
  sections: Section[];
  tables: AnswerTable[];
  asOf?: string;
}

/** `YYYY-MM-DD HH:mm UTC` from an ISO timestamp, without any locale or number formatting. */
export function asOfText(iso: string | undefined): string | undefined {
  const m = iso ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso) : null;
  return m ? `${m[1]} ${m[2]} UTC` : undefined;
}

export function buildAnswerView(a: Answer): AnswerView {
  const display = new Map((a.evidence ?? []).map((e) => [e.id, e.display]));
  const sections: Section[] = [];
  const add = (s: Section): void => {
    if (s.items.length) sections.push(s);
  };
  add({
    key: 'facts',
    title: S.sections.facts,
    items: (a.verified_facts ?? []).map((f) => f.statement),
  });
  add({
    key: 'calculations',
    title: S.sections.calculations,
    items: (a.derived_calculations ?? []).map((c) => {
      const shown = display.get(c.evidence_id);
      return shown ? `${c.label}: ${shown}` : c.label;
    }),
  });
  // Hypotheses never share a section with verified facts and always carry their warning.
  add({
    key: 'explanations',
    title: S.sections.explanations,
    items: (a.possible_explanations ?? []).map((e) => e.text),
    note: S.hypothesisNote,
  });
  add({
    key: 'recommendations',
    title: S.sections.recommendations,
    items: (a.recommendations ?? []).map((r) => r.text),
  });
  add({ key: 'unknowns', title: S.sections.unknowns, items: a.unknowns ?? [] });

  const bannerText = S.status[a.status];
  const tables = a.tables ?? [];
  return {
    banner: bannerText
      ? { tone: a.status === 'answered_facts_only' ? 'warning' : 'info', text: bannerText }
      : undefined,
    summary: a.summary,
    clarification: a.status === 'clarification_needed' ? a.clarification_question : undefined,
    sections,
    tables: tables.filter((t) => t.rows.length > 0),
    asOf: asOfText(tables.find((t) => t.as_of)?.as_of),
  };
}
