import type { SyntheticData, SyntheticRow } from '../../src/dev/synthetic-distributor';

// An independent calculation of what a plan should return, straight from the synthetic data in plain
// TypeScript. It shares no code with the plan compiler or the database, so agreement between the two
// is evidence that the compiler is right (docs/ai/evaluation.md, "execution accuracy").

export interface OraclePlan {
  measures: string[];
  dimensions?: { id: string; time_grain?: string }[];
  filters?: { dimension: string; values: string[] }[];
  time_range: { start: string; end: string };
}
export type Groups = Map<string, (number | null)[]>;

const num = (v: unknown): number => Number(v);
const addDays = (iso: string, n: number): string =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function grain(date: string, g: string | undefined): string {
  if (!g || g === 'day') return date;
  if (g === 'month') return `${date.slice(0, 7)}-01`;
  if (g === 'week') {
    const dow = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
    return addDays(date, -dow);
  }
  throw new Error(`oracle: unsupported grain ${g}`);
}

interface Fact {
  attrs: Record<string, string | null>;
  date: string;
  branchId: string;
  invoice?: SyntheticRow;
  line?: SyntheticRow;
  payment?: SyntheticRow;
}

const BASE: Record<string, 'invoice' | 'line' | 'payment'> = {
  revenue: 'invoice',
  invoice_count: 'invoice',
  average_order_value: 'invoice',
  outstanding_receivables: 'invoice',
  overdue_receivables: 'invoice',
  units_sold: 'line',
  line_revenue: 'line',
  gross_margin: 'line',
  payments_received: 'payment',
};

export function oracle(
  data: SyntheticData,
  plan: OraclePlan,
  opts: { asOf: string; branchIds?: string[] },
): Groups {
  const kinds = new Set(plan.measures.map((m) => BASE[m]));
  if (kinds.size !== 1) throw new Error('oracle: measures of one plan must share a base');
  const kind = [...kinds][0] as 'invoice' | 'line' | 'payment';
  const by = <T extends SyntheticRow>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const customers = by(data.customer);
  const branches = by(data.branch);
  const products = by(data.product);
  const invoices = by(data.invoice);

  const allocated = new Map<string, number>();
  for (const a of data.payment_allocation)
    allocated.set(
      a.invoice_id as string,
      (allocated.get(a.invoice_id as string) ?? 0) + num(a.amount),
    );

  const attrsOf = (
    customerId: string,
    branchId: string,
    productId?: string,
  ): Record<string, string | null> => {
    const c = customers.get(customerId) as SyntheticRow;
    const b = branches.get(branchId) as SyntheticRow;
    const out: Record<string, string | null> = {
      'customer.name': c.name as string,
      'customer.segment': c.segment as string,
      'customer.city': c.city as string,
      'branch.name': b.name as string,
      'branch.state': b.state as string,
    };
    if (productId) {
      const p = products.get(productId) as SyntheticRow;
      Object.assign(out, {
        'product.name': p.name as string,
        'product.category': p.category as string,
        'product.sub_category': p.sub_category as string,
        'product.brand': p.brand as string,
      });
    }
    return out;
  };

  const facts: Fact[] = [];
  if (kind === 'invoice')
    for (const i of data.invoice)
      facts.push({
        invoice: i,
        date: i.invoice_date as string,
        branchId: i.branch_id as string,
        attrs: {
          ...attrsOf(i.customer_id as string, i.branch_id as string),
          'invoice.invoice_date': i.invoice_date as string,
          'invoice.status': i.status as string,
        },
      });
  if (kind === 'line')
    for (const l of data.invoice_line) {
      const i = invoices.get(l.invoice_id as string) as SyntheticRow;
      facts.push({
        line: l,
        invoice: i,
        date: i.invoice_date as string,
        branchId: i.branch_id as string,
        attrs: {
          ...attrsOf(i.customer_id as string, i.branch_id as string, l.product_id as string),
          'invoice.invoice_date': i.invoice_date as string,
        },
      });
    }
  if (kind === 'payment')
    for (const p of data.payment) {
      const c = customers.get(p.customer_id as string) as SyntheticRow;
      facts.push({
        payment: p,
        date: p.payment_date as string,
        branchId: c.branch_id as string,
        attrs: {
          ...attrsOf(p.customer_id as string, c.branch_id as string),
          'payment.payment_date': p.payment_date as string,
        },
      });
    }

  const rows = facts.filter(
    (f) =>
      f.date >= plan.time_range.start &&
      f.date <= plan.time_range.end &&
      (!opts.branchIds || opts.branchIds.includes(f.branchId)) &&
      (plan.filters ?? []).every((flt) => flt.values.includes(f.attrs[flt.dimension] ?? '')),
  );

  const groups = new Map<string, Fact[]>();
  for (const f of rows) {
    const key = (plan.dimensions ?? [])
      .map((d) => (d.time_grain ? grain(f.date, d.time_grain) : (f.attrs[d.id] ?? '')))
      .join('|');
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  if ((plan.dimensions ?? []).length === 0 && groups.size === 0) groups.set('', []);

  const outstanding = (i: SyntheticRow): number => num(i.net_amount) - (allocated.get(i.id) ?? 0);
  const sum = (fs: Fact[], pick: (f: Fact) => number): number | null =>
    fs.length ? fs.reduce((s, f) => s + pick(f), 0) : null;
  const measure = (id: string, fs: Fact[]): number | null => {
    switch (id) {
      case 'revenue':
        return sum(fs, (f) => num(f.invoice?.net_amount));
      case 'invoice_count':
        return fs.length;
      case 'average_order_value':
        return fs.length
          ? (sum(fs, (f) => num(f.invoice?.net_amount)) as number) / fs.length
          : null;
      case 'outstanding_receivables':
        return sum(fs, (f) => outstanding(f.invoice as SyntheticRow));
      case 'overdue_receivables': {
        const late = fs.filter((f) => (f.invoice?.due_date as string) < opts.asOf);
        return sum(late, (f) => outstanding(f.invoice as SyntheticRow));
      }
      case 'units_sold':
        return sum(fs, (f) => num(f.line?.quantity));
      case 'line_revenue':
        return sum(fs, (f) => num(f.line?.net_amount));
      case 'gross_margin':
        return sum(fs, (f) => num(f.line?.net_amount) - num(f.line?.cost_amount));
      case 'payments_received':
        return sum(fs, (f) => num(f.payment?.amount));
      default:
        throw new Error(`oracle: unsupported measure ${id}`);
    }
  };
  return new Map([...groups].map(([k, fs]) => [k, plan.measures.map((m) => measure(m, fs))]));
}
