// A small valid v0.2.0 model for tests. Not the wholesale template.
interface Dimension {
  id: string;
  label: string;
  entity: string;
  attribute: string;
  type: string;
  diagnostic?: boolean;
  hierarchy?: { name: string; level: number };
}

export const validModel = () => ({
  version: 1,
  template: 'wholesale_distribution@0',
  settings: {
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    fiscal_year_start_month: 4,
    business_rules: [{ id: 'overdue_days', label: 'Overdue after', value: 90, unit: 'days' }],
  },
  entities: [
    { id: 'invoice', label: 'Invoice', table: 'analytics.invoice' },
    { id: 'branch', label: 'Branch', table: 'analytics.branch' },
  ],
  relationships: [
    { from: 'invoice', to: 'branch', on: [['branch_id', 'id']], cardinality: 'many_to_one' },
  ],
  measures: [
    {
      id: 'revenue',
      label: 'Revenue',
      entity: 'invoice',
      aggregation: 'sum',
      attribute: 'net_amount',
      metric_type: 'simple',
      additivity: 'additive',
      polarity: 'higher_is_better',
      unit: 'currency',
      default_time_dimension: 'invoice.date',
    },
    {
      id: 'cost',
      label: 'Cost',
      entity: 'invoice',
      aggregation: 'sum',
      attribute: 'cost_amount',
      metric_type: 'simple',
      additivity: 'additive',
      polarity: 'lower_is_better',
      unit: 'currency',
    },
    {
      id: 'margin_pct',
      label: 'Margin %',
      entity: 'invoice',
      aggregation: 'ratio',
      numerator: 'revenue',
      denominator: 'cost',
      metric_type: 'ratio',
      additivity: 'non_additive',
      polarity: 'higher_is_better',
      valid_dimensions: ['branch.name'],
      unit: 'percent',
    },
  ],
  dimensions: [
    {
      id: 'invoice.date',
      label: 'Invoice date',
      entity: 'invoice',
      attribute: 'invoice_date',
      type: 'time',
    },
    {
      id: 'branch.name',
      label: 'Branch',
      entity: 'branch',
      attribute: 'name',
      type: 'categorical',
      diagnostic: true,
      hierarchy: { name: 'geo', level: 2 },
    },
  ] as Dimension[],
  glossary: [{ term: 'sales', definition: 'Net invoiced amount', maps_to: 'measure:revenue' }],
});
