import type { ClavenarDenied } from './errors.js';

/**
 * Render a denied tool call's verbose-verdict breakdown as a readable
 * console panel — the developer-mode view. Returns the string; the SDK
 * writes it to stderr (via {@link emitDenyPanel}) when
 * {@link ClavenarOptions.devMode} is on.
 *
 * Pure (no I/O) so it's unit-testable. Falls back to a hint when the
 * gateway didn't include `detail` (verbose-verdicts off).
 */
export function renderDenyPanel(denied: ClavenarDenied): string {
  const lines: string[] = [];
  lines.push(`━━ clavenar denied: ${denied.toolName} ━━`);

  const meta: string[] = [];
  if (denied.layer) meta.push(`layer=${denied.layer}`);
  if (denied.intentCategory) meta.push(`intent=${denied.intentCategory}`);
  if (denied.correlationId) meta.push(`correlation=${denied.correlationId}`);
  if (meta.length) lines.push(`  ${meta.join('  ')}`);

  if (denied.reasons.length) {
    lines.push('  reasons:');
    for (const r of denied.reasons) lines.push(`    - ${r}`);
  }

  const detail = denied.detail;
  if (detail && detail.detectors.length) {
    lines.push('  detectors:');
    for (const d of detail.detectors) {
      const flag = d.flagged === true ? '  ⚠ flagged' : '';
      lines.push(`    ${d.detector.padEnd(22)}${d.score.toFixed(2)}${flag}`);
    }
    if (detail.degraded && detail.degraded.length) {
      lines.push(`  degraded: ${detail.degraded.join(', ')}`);
    }
  } else {
    lines.push(
      '  (no per-detector detail — run the gateway with CLAVENAR_PROXY_VERBOSE_VERDICTS=true)',
    );
  }

  if (denied.correlationId) {
    lines.push(`  trace: look up correlation ${denied.correlationId} in the console audit trail`);
  }
  return lines.join('\n');
}

/** Write the dev-mode deny panel to stderr. Best-effort — never throws. */
export function emitDenyPanel(denied: ClavenarDenied): void {
  try {
    // console.error works in Node and the browser; the SDK is isomorphic.
    console.error(renderDenyPanel(denied));
  } catch {
    /* never let dev-mode rendering interfere with the throw */
  }
}
