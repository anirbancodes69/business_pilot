import { createHash } from 'node:crypto';

// A deterministic, synthetic wholesale distributor for development and for the golden question set
// (E6.6). No real person or company: every name is made up. The same seed always gives the same data.
//
// Planted facts the evaluation can rely on (all dates in 2026, "today" is 2026-11-15):
//  - Nashik runs a big snack business through September (a promotion, five times the normal snack
//    volume) that nearly stops in October. It is the dominant cause of October's revenue drop, so a
//    "why did revenue drop" investigation should find Nashik, then Snacks.
//  - Customers "Gokul Provision" and "Shree Mart" pay late and rarely, so they hold the highest
//    outstanding receivables.
//  - Some payments are partial; every payment is allocated to one invoice.

export interface SyntheticRow {
  id: string;
  [column: string]: unknown;
}
export interface SyntheticData {
  branch: SyntheticRow[];
  customer: SyntheticRow[];
  product: SyntheticRow[];
  invoice: SyntheticRow[];
  invoice_line: SyntheticRow[];
  payment: SyntheticRow[];
  payment_allocation: SyntheticRow[];
}

const uuid = (ns: string, n: number): string => {
  const h = createHash('sha256').update(`${ns}:${n}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86_400_000);
const money = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);

const BRANCHES = [
  ['PUN', 'Pune', 'Pune'],
  ['NSK', 'Nashik', 'Nashik'],
  ['NGP', 'Nagpur', 'Nagpur'],
] as const;

const CUSTOMERS: [string, string, 'wholesale' | 'retail' | 'horeca', number][] = [
  ['Gokul Provision', 'C01', 'retail', 1],
  ['Shree Mart', 'C02', 'retail', 1],
  ['Anand Traders', 'C03', 'wholesale', 0],
  ['Kaveri Stores', 'C04', 'retail', 0],
  ['Mehta Brothers', 'C05', 'wholesale', 0],
  ['Sai Departmental', 'C06', 'retail', 1],
  ['Hotel Malhar', 'C07', 'horeca', 1],
  ['Patil Kirana', 'C08', 'retail', 1],
  ['Bhagat Wholesale', 'C09', 'wholesale', 2],
  ['Nagpur Fresh Mart', 'C10', 'retail', 2],
  ['Orange City Caterers', 'C11', 'horeca', 2],
  ['Vidarbha Supplies', 'C12', 'wholesale', 2],
];
const SLOW_PAYERS = new Set(['C01', 'C02']);

const PRODUCTS: [string, string, string, string, number][] = [
  ['SKU-101', 'Cola 2L', 'Beverages', 'Fizzo', 85],
  ['SKU-102', 'Orange Juice 1L', 'Beverages', 'Fruvo', 110],
  ['SKU-103', 'Mineral Water 20L', 'Beverages', 'Aquaa', 90],
  ['SKU-201', 'Potato Chips 100g', 'Snacks', 'Crunchy', 20],
  ['SKU-202', 'Namkeen Mix 400g', 'Snacks', 'Crunchy', 95],
  ['SKU-203', 'Biscuits Family Pack', 'Snacks', 'Tasty', 40],
  ['SKU-301', 'Basmati Rice 25kg', 'Staples', 'Annapurna', 1850],
  ['SKU-302', 'Sunflower Oil 15L', 'Staples', 'Golden', 1700],
];

export const SYNTHETIC_START = '2026-04-01';
export const SYNTHETIC_TODAY = '2026-11-15';

export function syntheticDistributor(seed = 42): SyntheticData {
  const r = rng(seed);
  const out: SyntheticData = {
    branch: [],
    customer: [],
    product: [],
    invoice: [],
    invoice_line: [],
    payment: [],
    payment_allocation: [],
  };
  BRANCHES.forEach(([code, name, city], i) =>
    out.branch.push({ id: uuid('branch', i), code, name, city, state: 'MH' }),
  );
  CUSTOMERS.forEach(([name, code, segment, b], i) =>
    out.customer.push({
      id: uuid('customer', i),
      code,
      name,
      segment,
      city: BRANCHES[b]?.[2],
      state: 'MH',
      branch_id: uuid('branch', b),
      credit_days: 30,
    }),
  );
  PRODUCTS.forEach(([sku, name, category, brand], i) =>
    out.product.push({
      id: uuid('product', i),
      sku,
      name,
      category,
      sub_category: category,
      brand,
      uom: 'unit',
    }),
  );

  const today = new Date(`${SYNTHETIC_TODAY}T00:00:00Z`);
  let invoiceN = 0;
  let lineN = 0;
  let paymentN = 0;
  for (let day = new Date(`${SYNTHETIC_START}T00:00:00Z`); day < today; day = addDays(day, 1)) {
    if (day.getUTCDay() === 0) continue; // closed on Sundays
    for (const [ci, c] of CUSTOMERS.entries()) {
      if (r() > 0.2) continue; // roughly one invoice per customer every five trading days
      const branchIdx = c[3];
      const dateStr = iso(day);
      const october = dateStr >= '2026-10-01' && dateStr < '2026-11-01';
      const lines: { p: number; qty: number; price: number }[] = [];
      const n = 1 + Math.floor(r() * 3);
      for (let k = 0; k < n; k++) {
        const p = Math.floor(r() * PRODUCTS.length);
        const product = PRODUCTS[p] as (typeof PRODUCTS)[number];
        // Planted: Nashik snacks nearly stop selling in October after a strong run before it.
        const nashikSnacks = branchIdx === 1 && product[2] === 'Snacks';
        if (october && nashikSnacks && r() < 0.95) continue;
        const base = product[4] > 1000 ? 1 + Math.floor(r() * 4) : 5 + Math.floor(r() * 40);
        const qty = nashikSnacks && !october ? base * 5 : base;
        lines.push({ p, qty, price: product[4] });
      }
      if (lines.length === 0) continue;
      const id = uuid('invoice', invoiceN);
      const gross = lines.reduce((s, l) => s + l.qty * l.price, 0);
      const tax = gross * 0.18;
      const net = gross + tax;
      out.invoice.push({
        id,
        number: `INV-${String(1000 + invoiceN)}`,
        invoice_date: dateStr,
        due_date: iso(addDays(day, 30)),
        customer_id: uuid('customer', ci),
        branch_id: uuid('branch', branchIdx),
        status: 'open',
        currency: 'INR',
        gross_amount: money(gross),
        tax_amount: money(tax),
        net_amount: money(net),
      });
      for (const l of lines) {
        const lineNet = l.qty * l.price;
        out.invoice_line.push({
          id: uuid('line', lineN++),
          invoice_id: id,
          product_id: uuid('product', l.p),
          quantity: l.qty.toFixed(3),
          unit_price: money(l.price),
          discount_amount: '0.00',
          net_amount: money(lineNet),
          cost_amount: money(lineNet * (0.7 + r() * 0.15)),
        });
      }
      // Payments: slow payers rarely pay; others mostly pay in full around the due date.
      const slow = SLOW_PAYERS.has(c[1]);
      const roll = r();
      const share = slow ? (roll < 0.15 ? 1 : 0) : roll < 0.7 ? 1 : roll < 0.85 ? 0.5 : 0;
      const payDate = addDays(day, 25 + Math.floor(r() * 20));
      if (share > 0 && payDate < today) {
        const pid = uuid('payment', paymentN);
        const amount = net * share;
        out.payment.push({
          id: pid,
          customer_id: uuid('customer', ci),
          payment_date: iso(payDate),
          amount: money(amount),
          currency: 'INR',
          method: 'bank_transfer',
          reference: `PAY-${String(5000 + paymentN)}`,
        });
        out.payment_allocation.push({
          id: uuid('alloc', paymentN),
          payment_id: pid,
          invoice_id: id,
          amount: money(amount),
        });
        paymentN++;
      }
      invoiceN++;
    }
  }
  return out;
}
