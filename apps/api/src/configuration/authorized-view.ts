import type { AuthorizationContext } from '../authorization/authorization';
import type { SemanticModelDocument } from './semantic-model.validator';

// Authorized semantic view (contracts/semantic-model/README.md): the only description of the
// business that ai-engine and the LLM ever see. Semantic IDs, labels, descriptions and synonyms
// only. Never physical tables or columns, expression or formula references, row filter values,
// member names, or items the user is not granted (absent, not marked hidden).

export interface AuthorizedView {
  semantic_model_version: number;
  tenant_settings: {
    currency: string;
    timezone: string;
    fiscal_year_start_month: number;
    number_format?: string;
  };
  business_rules: { id: string; label: string; value: number; unit: string }[];
  entities: { id: string; label: string; description?: string; synonyms?: string[] }[];
  measures: {
    id: string;
    label: string;
    description?: string;
    unit: string;
    synonyms?: string[];
    default_time_dimension?: string;
    metric_type: string;
    additivity: string;
    polarity: string;
    business_definition?: string;
    certified?: boolean;
    valid_dimensions?: string[];
    drivers?: { components: string[] }[];
  }[];
  dimensions: {
    id: string;
    label: string;
    type: string;
    synonyms?: string[];
    hierarchy?: { name: string; level: number };
    diagnostic?: boolean;
  }[];
  glossary: { term: string; definition: string; maps_to?: string }[];
}

export function buildAuthorizedView(
  model: SemanticModelDocument,
  ctx: AuthorizationContext,
): AuthorizedView {
  const entities = new Set(ctx.granted.entities);
  const masked = new Set(ctx.column_masks.map((m) => `${m.entity}.${m.attribute}`));

  // Dimensions: granted, on a granted entity, and the underlying column is not masked.
  const dims = model.dimensions.filter(
    (d) =>
      ctx.granted.dimensions.includes(d.id) &&
      entities.has(d.entity) &&
      !masked.has(`${d.entity}.${d.attribute}`),
  );
  const dimIds = new Set(dims.map((d) => d.id));

  // Measures: granted, on a granted entity, source column not masked, and (for ratios) both parts visible.
  // Iterate to a fixed point so a ratio whose part was removed is removed too.
  let measures = model.measures.filter(
    (m) =>
      ctx.granted.measures.includes(m.id) &&
      entities.has(m.entity) &&
      !(m.attribute && masked.has(`${m.entity}.${m.attribute}`)),
  );
  for (;;) {
    const ids = new Set(measures.map((m) => m.id));
    const next = measures.filter(
      (m) => (!m.numerator || ids.has(m.numerator)) && (!m.denominator || ids.has(m.denominator)),
    );
    if (next.length === measures.length) break;
    measures = next;
  }
  const measureIds = new Set(measures.map((m) => m.id));
  const visibleEntities = model.entities.filter((e) => entities.has(e.id));
  const visibleEntityIds = new Set(visibleEntities.map((e) => e.id));

  const targets = {
    measure: measureIds,
    dimension: dimIds,
    entity: visibleEntityIds,
  } as const;

  const compact = <T extends object>(o: T): T =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

  return {
    semantic_model_version: model.version,
    tenant_settings: compact({
      currency: model.settings.currency,
      timezone: model.settings.timezone,
      fiscal_year_start_month: model.settings.fiscal_year_start_month,
      number_format: model.settings.number_format,
    }),
    business_rules: (model.settings.business_rules ?? []).map((r) => ({
      id: r.id,
      label: r.label,
      value: r.value,
      unit: r.unit,
    })),
    entities: visibleEntities.map((e) =>
      compact({ id: e.id, label: e.label, description: e.description, synonyms: e.synonyms }),
    ),
    measures: measures.map((m) => {
      const validDims = m.valid_dimensions?.filter((d) => dimIds.has(d));
      const drivers = m.drivers
        ?.filter((d) => d.components.every((c) => measureIds.has(c)))
        .map((d) => ({ components: d.components }));
      return compact({
        id: m.id,
        label: m.label,
        description: m.description,
        unit: m.unit,
        synonyms: m.synonyms,
        default_time_dimension:
          m.default_time_dimension && dimIds.has(m.default_time_dimension)
            ? m.default_time_dimension
            : undefined,
        metric_type: m.metric_type,
        additivity: m.additivity,
        polarity: m.polarity,
        business_definition: m.business_definition,
        certified: m.certified,
        valid_dimensions: validDims,
        drivers: drivers?.length ? drivers : undefined,
      });
    }),
    dimensions: dims.map((d) =>
      compact({
        id: d.id,
        label: d.label,
        type: d.type,
        synonyms: d.synonyms,
        hierarchy: d.hierarchy,
        diagnostic: d.diagnostic,
      }),
    ),
    glossary: (model.glossary ?? [])
      .filter((g) => {
        if (!g.maps_to) return true;
        const [kind, id] = g.maps_to.split(':') as [keyof typeof targets, string];
        return targets[kind].has(id);
      })
      .map((g) => compact({ term: g.term, definition: g.definition, maps_to: g.maps_to })),
  };
}
