import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('client migration fixture', () => {
  it('packages the explicit decision migration boundary', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/client-migration-v1.fixture.json', import.meta.url), 'utf8'),
    ) as {
      contract: string;
      minimumSafeVersions: Record<string, string>;
      legacyRejection: Record<string, unknown>;
      invariants: Record<string, boolean>;
    };
    const schema = JSON.parse(
      readFileSync(new URL('../fixtures/client-migration-v1.schema.json', import.meta.url), 'utf8'),
    ) as { properties: { contract: { const: string } } };
    expect(fixture.contract).toBe('clavenar.client-migration/v1');
    expect(fixture.minimumSafeVersions['typescript']).toBe('1.5.0');
    expect(fixture.legacyRejection).toMatchObject({
      httpStatus: 426,
      executable: false,
      toolEffectCount: 0,
    });
    expect(fixture.invariants['legacyInspectionCannotExecute']).toBe(true);
    expect(schema.properties.contract.const).toBe(fixture.contract);
  });
});
