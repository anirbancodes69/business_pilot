import type { Answer, QuestionResponse } from './answer-view';

// Conversation history helpers (ADR-0021). Pure: no fetching, no clock except the `now` passed in.

export interface ConversationSummary {
  id: string;
  title: string;
  updated_at: string;
  turns: number;
}
export interface StoredTurn {
  turn: number;
  question: string | null;
  answer: Answer | null;
  created_at: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `Today`, `Yesterday`, otherwise `15 Nov 2026`, by UTC calendar day. */
export function dayLabel(iso: string, now: Date): string {
  const d = new Date(iso);
  const day = (x: Date): number => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export interface Group {
  label: string;
  items: ConversationSummary[];
}

/** Groups by day label, keeping the server's newest-first order. */
export function groupConversations(list: ConversationSummary[], now: Date): Group[] {
  const groups: Group[] = [];
  for (const c of list) {
    const label = dayLabel(c.updated_at, now);
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(c);
    else groups.push({ label, items: [c] });
  }
  return groups;
}

/** A stored turn as a response the answer card can show (null when the answer was not kept). */
export function storedToResponse(
  conversationId: string,
  t: StoredTurn,
): QuestionResponse | undefined {
  return t.answer ? { conversation_id: conversationId, turn: t.turn, answer: t.answer } : undefined;
}
