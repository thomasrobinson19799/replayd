// PRD §2.1. D-20's existing terminal-mock exception is not extended to other pages.
export function replayFailures(result) {
  const failures = [];
  const under = (key, limit, inclusive = false) => {
    const value = result[key];
    if (!Number.isFinite(value) || (inclusive ? value > limit : value >= limit))
      failures.push(`${key} must be ${inclusive ? '<=' : '<'} ${limit}`);
  };
  if (![1, 4].includes(result.rate)) failures.push('No acceptance budget for this CPU rate');
  under('snapshot_ms', result.rate === 1 ? 50 : 150);
  under('batch_p95_ms', result.rate === 4 && result.scenario.startsWith('terminal-') ? 7.58 : 2);
  under('uplink_kb_s', 5, true);
  under('long_tasks_after_snapshot', 0, true);
  const checks = result.checks;
  if (!Array.isArray(checks) || checks.length === 0) failures.push('Missing per-run capture checks');
  else checks.forEach((check, i) => {
    if (!check || !Array.isArray(check.bad) || !(check.segments >= 1) || !(check.fullSnapshots >= 1))
      failures.push(`run ${i + 1}: incomplete capture evidence`);
    else for (const error of check.bad) failures.push(`run ${i + 1}: ${error}`);
  });
  return failures;
}
