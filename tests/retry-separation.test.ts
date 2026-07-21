import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('retry separation fixture', () => {
  it('packages the exact decision-only retry contract', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../fixtures/retry-separation-v1.fixture.json', import.meta.url), 'utf8'),
    ) as {
      contract: string;
      cases: Array<Record<string, unknown>>;
      invariants: Record<string, boolean>;
    };
    expect(fixture.contract).toBe('clavenar.retry-separation/v1');
    const decision = fixture.cases.find((value) => value['id'] === 'explicit-side-effect-free-decision');
    const execution = fixture.cases.find((value) => value['id'] === 'sdk-registered-executor');
    expect(decision).toMatchObject({ automaticTransportRetry: true, maximumEffectAttempts: 0 });
    expect(execution).toMatchObject({ automaticTransportRetry: false, maximumEffectAttempts: 1 });
    expect(fixture.invariants['executorFailuresNeverEnterTransportRetryLoop']).toBe(true);
  });
});
