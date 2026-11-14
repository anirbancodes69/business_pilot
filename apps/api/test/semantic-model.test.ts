import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  semanticModelShape,
  validateSemanticModel,
} from '../src/configuration/semantic-model.validator';
import { wholesaleDistributionTemplate } from '../src/configuration/templates/wholesale-distribution';
import { validModel } from './fixtures/semantic-model';

const jsonSchema = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../../schemas/semantic-model/semantic-model.schema.json'),
    'utf8',
  ),
) as { properties: Record<string, unknown> };

describe('semantic model validator', () => {
  it('accepts a valid model', () => {
    expect(validateSemanticModel(validModel()).problems).toEqual([]);
  });

  it('has the same top-level properties as the JSON Schema', () => {
    expect(Object.keys(semanticModelShape).sort()).toEqual(
      Object.keys(jsonSchema.properties).sort(),
    );
  });

  it('has the same measure and dimension properties as the JSON Schema', () => {
    const js = jsonSchema as unknown as {
      properties: {
        measures: { items: { properties: object } };
        dimensions: { items: { properties: object } };
      };
    };
    const sample = validModel();
    const keysOf = (items: object[]) => new Set(items.flatMap((i) => Object.keys(i)));
    for (const k of keysOf(sample.measures))
      expect(Object.keys(js.properties.measures.items.properties)).toContain(k);
    for (const k of keysOf(sample.dimensions))
      expect(Object.keys(js.properties.dimensions.items.properties)).toContain(k);
  });

  it('rejects unknown properties (no physical SQL or hidden fields)', () => {
    const m = { ...validModel(), sql: 'select 1' };
    expect(validateSemanticModel(m).problems.length).toBeGreaterThan(0);
  });

  it('rejects entity tables outside the analytics schema', () => {
    const m = validModel();
    m.entities[0]!.table = 'core.tenant';
    expect(validateSemanticModel(m).problems.length).toBeGreaterThan(0);
  });

  it('accepts only plain identifiers as column names (they become SQL identifiers in the compiler)', () => {
    const unsafe = [
      'net_amount) FROM analytics.customer; --',
      'x"; drop table y; --',
      'Net Amount',
      '',
    ];
    for (const name of unsafe) {
      const measure = validModel();
      measure.measures[0]!.attribute = name;
      expect(validateSemanticModel(measure).problems.length).toBeGreaterThan(0);
      const dimension = validModel();
      dimension.dimensions[0]!.attribute = name;
      expect(validateSemanticModel(dimension).problems.length).toBeGreaterThan(0);
      const join = validModel();
      join.relationships[0]!.on = [[name, 'id']];
      expect(validateSemanticModel(join).problems.length).toBeGreaterThan(0);
      const filter = validModel() as ReturnType<typeof validModel> & {
        measures: { filters?: unknown }[];
      };
      filter.measures[0]!.filters = [{ attribute: name, operator: 'eq', values: ['x'] }];
      expect(validateSemanticModel(filter).problems.length).toBeGreaterThan(0);
    }
  });

  it('checks references and duplicates', () => {
    const m = validModel();
    m.measures[0]!.entity = 'nope';
    m.measures[2]!.numerator = 'ghost';
    m.dimensions.push({ ...m.dimensions[1]! });
    m.glossary[0]!.maps_to = 'measure:ghost';
    const p = validateSemanticModel(m).problems.join('\n');
    expect(p).toContain('unknown entity nope');
    expect(p).toContain('unknown measure ghost');
    expect(p).toContain('duplicate dimension id');
    expect(p).toContain('unknown target');
  });

  it('requires an attribute for sum and an expression_ref for custom', () => {
    const m = validModel();
    delete (m.measures[0] as { attribute?: string }).attribute;
    m.measures.push({
      id: 'x',
      label: 'X',
      entity: 'invoice',
      aggregation: 'custom',
      metric_type: 'simple',
      additivity: 'additive',
      polarity: 'neutral',
      unit: 'count',
    } as never);
    const p = validateSemanticModel(m).problems.join('\n');
    expect(p).toContain('sum needs attribute');
    expect(p).toContain('custom needs expression_ref');
  });

  it('enforces ADR-0013 rules', () => {
    const m = validModel();
    m.measures[2]!.additivity = 'additive';
    m.measures[2]!.valid_dimensions = ['ghost.dim'];
    m.measures.push({
      id: 'd',
      label: 'D',
      entity: 'invoice',
      aggregation: 'custom',
      expression_ref: 'e',
      metric_type: 'derived',
      additivity: 'non_additive',
      polarity: 'neutral',
      unit: 'count',
      drivers: [{ formula_ref: 'f', components: ['revenue', 'nope'] }],
    } as never);
    m.dimensions[0]!.hierarchy = { name: 'geo', level: 2 };
    const p = validateSemanticModel(m).problems.join('\n');
    expect(p).toContain('a ratio must be non_additive');
    expect(p).toContain('unknown valid dimension ghost.dim');
    expect(p).toContain('derived needs formula_ref');
    expect(p).toContain('unknown driver component nope');
    expect(p).toContain('hierarchy geo: duplicate level');
  });

  it('requires additivity and polarity', () => {
    const m = validModel();
    delete (m.measures[0] as { additivity?: string }).additivity;
    expect(validateSemanticModel(m).problems.join()).toContain('additivity');
  });
});

describe('wholesale_distribution template', () => {
  it('is a valid semantic model', () => {
    expect(validateSemanticModel(wholesaleDistributionTemplate()).problems).toEqual([]);
  });
});
