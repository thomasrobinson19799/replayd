// AGENTS.md rule 3: @replayd/core must never have runtime dependencies.
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../packages/core/package.json', import.meta.url), 'utf8'));
const deps = { ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies };
if (Object.keys(deps).length) {
  console.error(`@replayd/core has runtime dependencies: ${Object.keys(deps).join(', ')}`);
  process.exit(1);
}
