// Interpret one launcher/manifest inventory. These checks do not discover, launch or modify anything.
import { HARNESS_FACTS } from './agent-definition-schema.mjs';
import { passed, unanswered } from './health.mjs';

export function harnessChecks(inventory) {
  if (!inventory || !Array.isArray(inventory.known) || !Array.isArray(inventory.unknown))
    return [unanswered('harness-table', 'harness inventory unavailable')];
  const rows = [], { known, unknown } = inventory;
  if (unknown.length) rows.push(unanswered('harness-table', unknown.map(row => `${row.command}: ${row.reason}`).join('; ')));
  const deferred = known.filter(row => Object.hasOwn(HARNESS_FACTS, row.client) && HARNESS_FACTS[row.client].definition !== true);
  if (deferred.length) rows.push(passed('harness-definitions', deferred.map(row => {
    const facts = HARNESS_FACTS[row.client];
    return `${row.client}: definition admission deferred; managed launcher ${facts.managed === true ? 'supported' : 'unsupported'}; `
      + `resident ${facts.resident === true ? 'supported' : `unsupported (${facts.residentReason})`}; launcher capability does not grant definition support`;
  }).join('; ')));
  const unsupported = known.filter(row => Object.hasOwn(HARNESS_FACTS, row.client) && HARNESS_FACTS[row.client].screen === false);
  // An absent expectation fails closed; only an explicit unsupported fact makes a missing manifest informational.
  const unobserved = known.filter(row => HARNESS_FACTS[row.client]?.screen !== false && row.screen?.state !== 'loaded');
  const screenDetails = [
    ...unobserved.map(row => `${row.client}: screen observation unknown (${row.screen?.reason || 'manifest not observed'})`),
    ...unsupported.map(row => `${row.client}: screen detection unsupported by design`),
  ];
  if (screenDetails.length) rows.push((unobserved.length ? unanswered : passed)('harness-manifests', screenDetails.join('; ')));
  return rows;
}
