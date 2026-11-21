// Naming only. Each caller still owns validation and what it does when no URL was named.
export const ENV_ENDPOINT_NAMES = Object.freeze(['AIFY_ENV_ENDPOINT', 'AIFY_ENV_URL']);

export function readEnvEndpoint(env = process.env) {
  const [canonical, alias] = ENV_ENDPOINT_NAMES;
  return env[canonical] || env[alias] || '';
}

/** Keep the legacy binding until a wrapper that reads the canonical name is pinned. */
export function envEndpointBindings(endpoint) {
  return Object.fromEntries(ENV_ENDPOINT_NAMES.map(name => [name, endpoint]));
}
