// A small valid v0 model for tests. Not the wholesale template.
export const validModel = () => ({
  version: 1,
  template: 'wholesale_distribution@0',
  settings: { currency: 'INR', timezone: 'Asia/Kolkata', fiscal_year_start_month: 4 },
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
      unit: 'currency',
      default_time_dimension: 'invoice.date',
    },
    {
      id: 'cost',
      label: 'Cost',
      entity: 'invoice',
      aggregation: 'sum',
      attribute: 'cost_amount',
      unit: 'currency',
    },
    {
      id: 'margin_pct',
      label: 'Margin %',
      entity: 'invoice',
      aggregation: 'ratio',
      numerator: 'revenue',
      denominator: 'cost',
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
    },
  ],
  glossary: [{ term: 'sales', definition: 'Net invoiced amount', maps_to: 'measure:revenue' }],
});
