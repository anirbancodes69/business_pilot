import { describe, expect, it } from 'vitest';
import { syntheticDistributor } from '../src/dev/synthetic-distributor';

const num = (v: unknown) => Number(v);

describe('synthetic distributor', () => {
  const d = syntheticDistributor();

  it('is deterministic', () => {
    expect(syntheticDistributor()).toEqual(d);
    expect(syntheticDistributor(7).invoice.length).not.toBe(d.invoice.length);
  });

  it('has consistent references and unique ids', () => {
    const ids = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));
    const customers = ids(d.customer);
    const branches = ids(d.branch);
    const invoices = ids(d.invoice);
    const products = ids(d.product);
    const payments = ids(d.payment);
    expect(invoices.size).toBe(d.invoice.length);
    expect(
      d.invoice.every(
        (i) => customers.has(i.customer_id as string) && branches.has(i.branch_id as string),
      ),
    ).toBe(true);
    expect(
      d.invoice_line.every(
        (l) => invoices.has(l.invoice_id as string) && products.has(l.product_id as string),
      ),
    ).toBe(true);
    expect(
      d.payment_allocation.every(
        (a) => payments.has(a.payment_id as string) && invoices.has(a.invoice_id as string),
      ),
    ).toBe(true);
    expect(d.invoice.length).toBeGreaterThan(300);
  });

  it('invoice totals add up and no payment exceeds its invoice', () => {
    const lines = new Map<string, number>();
    for (const l of d.invoice_line)
      lines.set(
        l.invoice_id as string,
        (lines.get(l.invoice_id as string) ?? 0) + num(l.net_amount),
      );
    for (const i of d.invoice) expect(num(i.gross_amount)).toBeCloseTo(lines.get(i.id) ?? 0, 1);
    const net = new Map(d.invoice.map((i) => [i.id, num(i.net_amount)]));
    for (const a of d.payment_allocation)
      expect(num(a.amount)).toBeLessThanOrEqual((net.get(a.invoice_id as string) ?? 0) + 0.01);
  });

  it('contains the planted facts', () => {
    const inv = new Map(d.invoice.map((i) => [i.id, i]));
    const prod = new Map(d.product.map((p) => [p.id, p]));
    const nashik = d.branch.find((b) => b.name === 'Nashik')?.id;
    const snacks = (month: string) =>
      d.invoice_line
        .filter((l) => {
          const i = inv.get(l.invoice_id as string);
          return (
            i?.branch_id === nashik &&
            String(i?.invoice_date).startsWith(month) &&
            prod.get(l.product_id as string)?.category === 'Snacks'
          );
        })
        .reduce((s, l) => s + num(l.net_amount), 0);
    expect(snacks('2026-10')).toBeLessThan(snacks('2026-09') * 0.5);

    const owed = new Map<string, number>();
    const paid = new Map<string, number>();
    for (const a of d.payment_allocation) paid.set(a.invoice_id as string, num(a.amount));
    for (const i of d.invoice)
      owed.set(
        i.customer_id as string,
        (owed.get(i.customer_id as string) ?? 0) + num(i.net_amount) - (paid.get(i.id) ?? 0),
      );
    const top = [...owed.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([id]) => d.customer.find((c) => c.id === id)?.name);
    expect(new Set(top)).toEqual(new Set(['Gokul Provision', 'Shree Mart']));
  });
});
