// HTTP authority is a separate boundary from browser metadata: rebinding reads can be same-origin.
import { isIP } from 'node:net';

export const AUTHORITY_SETTING = 'http.trustedAuthorities';
const settingHelp = `${AUTHORITY_SETTING} in ~/.aify/config.json`;

/** Strict host[:port], not a URL: never normalize paths, userinfo, wildcards or abbreviated IPs into trust. */
function authorityFrom(value) {
  if (typeof value !== 'string' || !value || /[^\x21-\x7e]/.test(value)) return null;
  let host, portText;
  if (value.startsWith('[')) {
    const match = /^(\[[^\]]+\])(?::([0-9]{1,5}))?$/.exec(value);
    if (!match || isIP(match[1].slice(1, -1)) !== 6) return null;
    try { host = new URL(`http://${match[1]}`).hostname; } catch { return null; }
    portText = match[2];
  } else {
    const match = /^([^:]+)(?::([0-9]{1,5}))?$/.exec(value);
    if (!match) return null;
    host = match[1].toLowerCase();
    portText = match[2];
    if (isIP(host) !== 4) {
      if (host.length > 253 || /^[0-9.]+$/.test(host)
        || !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
      // WHATWG accepts integer/hex/short IPv4 forms. A DNS grant must remain the exact DNS name.
      try { if (new URL(`http://${host}`).hostname !== host) return null; } catch { return null; }
    }
  }
  const port = portText === undefined ? null : Number(portText);
  if (port !== null && (port < 1 || port > 65535)) return null;
  return { host, port, text: host + (port === null ? '' : `:${port}`) };
}

/** An invalid list grants NONE of its extras; it never disables the loopback default. Pure, used at config load. */
export function trustedAuthoritiesFrom(value, problem = '') {
  const fail = detail => ({ trustedAuthorities: [], problems: [`${settingHelp}: ${detail}; extra authorities disabled`] });
  if (problem) return fail(problem);
  if (value === undefined) return { trustedAuthorities: [], problems: [] };
  if (!Array.isArray(value)) return fail('must be a list of host or host:port authorities');
  const parsed = value.map(authorityFrom);
  const bad = parsed.findIndex(authority => authority === null);
  if (bad !== -1) return fail(`entry ${bad + 1} is not a strict authority`);
  return { trustedAuthorities: [...new Set(parsed.map(authority => authority.text))], problems: [] };
}

/** A refusal string, or empty when the one on-wire Host is local or explicitly trusted. Pure. */
export function httpAuthorityProblem(rawHeaders, trustedAuthorities = []) {
  const refuse = detail => `${detail}; Host must be loopback or explicitly listed in ${settingHelp}`;
  if (!Array.isArray(rawHeaders) || rawHeaders.length % 2 !== 0) return refuse('missing or malformed Host headers');
  const hosts = [];
  for (let at = 0; at < rawHeaders.length; at += 2) {
    if (typeof rawHeaders[at] !== 'string' || typeof rawHeaders[at + 1] !== 'string') return refuse('malformed Host headers');
    if (rawHeaders[at].toLowerCase() === 'host') hosts.push(rawHeaders[at + 1]);
  }
  if (hosts.length !== 1) return refuse('exactly one Host header is required');
  const authority = authorityFrom(hosts[0]);
  if (!authority) return refuse('malformed Host authority');
  if (authority.host === 'localhost' || authority.host === '[::1]'
    || (isIP(authority.host) === 4 && authority.host.split('.')[0] === '127')) return '';
  const admitted = Array.isArray(trustedAuthorities) && trustedAuthorities.some(value => {
    const trusted = authorityFrom(value);
    return trusted && trusted.host === authority.host
      && (trusted.port === null || trusted.port === (authority.port ?? 80));
  });
  return admitted ? '' : refuse('untrusted Host authority');
}
