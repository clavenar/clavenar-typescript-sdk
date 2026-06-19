import { describe, expect, it } from 'vitest';
import { renderDenyPanel } from '../src/devmode.js';
import { ClavenarDenied } from '../src/errors.js';

describe('renderDenyPanel', () => {
  it('renders the detector breakdown when detail is present', () => {
    const denied = new ClavenarDenied({
      toolName: 'send_email',
      reasons: ['indirect prompt injection'],
      reviewReasons: [],
      intentCategory: 'Exfiltration',
      layer: 'brain',
      correlationId: 'abc-123',
      detail: {
        detectors: [
          { detector: 'persona_drift', score: 0.12 },
          { detector: 'injection', score: 0.91, flagged: true },
        ],
        degraded: ['injection'],
      },
    });
    const panel = renderDenyPanel(denied);
    expect(panel).toContain('send_email');
    expect(panel).toContain('layer=brain');
    expect(panel).toContain('correlation=abc-123');
    expect(panel).toContain('injection');
    expect(panel).toContain('0.91');
    expect(panel).toContain('⚠ flagged');
    expect(panel).toContain('degraded: injection');
  });

  it('hints to enable verbose verdicts when detail is absent', () => {
    const denied = new ClavenarDenied({
      toolName: 'wire_transfer',
      reasons: ['policy denied'],
      reviewReasons: [],
      intentCategory: 'Direct Execution',
    });
    const panel = renderDenyPanel(denied);
    expect(panel).toContain('wire_transfer');
    expect(panel).toContain('CLAVENAR_PROXY_VERBOSE_VERDICTS');
  });
});
