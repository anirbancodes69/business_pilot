import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  semanticModelShape,
  validateSemanticModel,
} from '../src/configuration/semantic-model.validator';
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

  it('rejects unknown properties (no physical SQL or hidden fields)', () => {
    const m = { ...validModel(), sql: 'select 1' };
    expect(validateSemanticModel(m).problems.length).toBeGreaterThan(0);
  });

  it('rejects entity tables outside the analytics schema', () => {
    const m = validModel();
    m.entities[0]!.table = 'core.tenant';
    expect(validateSemanticModel(m).problems.length).toBeGreaterThan(0);
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
      unit: 'count',
    } as never);
    const p = validateSemanticModel(m).problems.join('\n');
    expect(p).toContain('sum needs attribute');
    expect(p).toContain('custom needs expression_ref');
  });
});
