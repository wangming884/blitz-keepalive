/**
 * Target URL safety.
 *
 * Every URL the agent is asked to open - and every main-frame navigation the
 * browser performs afterwards (redirects included) - goes through
 * validateTargetUrl(). Keeping the rules in one module makes them testable on
 * their own and keeps the entrypoint from growing further.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export const DEFAULT_TARGET_URL_ALLOWLIST = '*.blitz.cloud';
const TARGET_URL_DNS_CACHE_MS = 60_000;

const PRIVATE_NETWORKS = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) {
  PRIVATE_NETWORKS.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
]) {
  PRIVATE_NETWORKS.addSubnet(network, prefix, 'ipv6');
}
const TARGET_URL_DNS_CACHE = new Map();

export class TargetUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TargetUrlError';
  }
}

export function normalizeHostname(value) {
  return String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
}

export function parseTargetUrlAllowlist(raw) {
  const source = raw === undefined || raw === null || String(raw).trim() === ''
    ? DEFAULT_TARGET_URL_ALLOWLIST
    : String(raw);
  const entries = source
    .split(/[\s,;]+/)
    .map(normalizeHostname)
    .filter(Boolean);
  if (entries.length === 0) entries.push(DEFAULT_TARGET_URL_ALLOWLIST);
  for (const entry of entries) {
    if (entry === '*') continue;
    if (entry.startsWith('*.')) {
      const domain = entry.slice(2);
      if (!domain || domain.includes('*') || (!isIP(domain) && !/^[a-z0-9.-]+$/.test(domain))) {
        throw new Error(`TARGET_URL_ALLOWLIST contains an invalid wildcard entry: ${entry}`);
      }
      continue;
    }
    if (entry.includes('*') || (!isIP(entry) && !/^[a-z0-9.-]+$/.test(entry))) {
      throw new Error(`TARGET_URL_ALLOWLIST contains an invalid hostname: ${entry}`);
    }
  }
  return entries;
}

export function targetHostAllowed(hostname, allowlist) {
  const host = normalizeHostname(hostname);
  return allowlist.some((entry) => {
    if (entry === '*') return true;
    if (entry.startsWith('*.')) return host.endsWith(entry.slice(1));
    return host === entry;
  });
}

export function normalizeIpAddress(raw) {
  const value = String(raw ?? '').trim().replace(/^\[|\]$/g, '');
  const withoutZone = value.includes('%') ? value.slice(0, value.indexOf('%')) : value;
  const mapped = withoutZone.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (mapped && isIP(mapped[1]) === 4) return { address: mapped[1], family: 4 };
  const family = isIP(withoutZone);
  return family ? { address: withoutZone, family } : null;
}

export function isPrivateIpAddress(address) {
  const normalized = normalizeIpAddress(address);
  if (!normalized) return false;
  return PRIVATE_NETWORKS.check(
    normalized.address,
    normalized.family === 4 ? 'ipv4' : 'ipv6',
  );
}

export function parseTrustedProxyCidrs(raw) {
  const block = new BlockList();
  const entries = String(raw ?? '')
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    const separator = entry.lastIndexOf('/');
    const address = separator === -1 ? entry : entry.slice(0, separator);
    const family = isIP(address);
    if (!family) throw new Error(`TRUST_PROXY_CIDRS contains an invalid address: ${entry}`);
    const maxPrefix = family === 4 ? 32 : 128;
    const prefix = separator === -1 ? maxPrefix : Number(entry.slice(separator + 1));
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
      throw new Error(`TRUST_PROXY_CIDRS contains an invalid prefix: ${entry}`);
    }
    block.addSubnet(address, prefix, family === 4 ? 'ipv4' : 'ipv6');
  }
  return block;
}

export function isTrustedProxyAddress(trustedProxies, address) {
  const normalized = normalizeIpAddress(address);
  if (!normalized) return false;
  return trustedProxies.check(
    normalized.address,
    normalized.family === 4 ? 'ipv4' : 'ipv6',
  );
}

async function resolveTargetHost(hostname) {
  const key = normalizeHostname(hostname);
  const cached = TARGET_URL_DNS_CACHE.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.addresses;
  let addresses;
  try {
    addresses = await lookup(key, { all: true, verbatim: true });
  } catch {
    throw new TargetUrlError(`无法解析目标域名：${key}`);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new TargetUrlError(`目标域名没有可用地址：${key}`);
  }
  TARGET_URL_DNS_CACHE.set(key, {
    addresses,
    expiresAt: Date.now() + TARGET_URL_DNS_CACHE_MS,
  });
  return addresses;
}

/**
 * Validates a target URL and returns the addresses it resolved to.
 *
 * Returning the addresses lets the caller pin them into Chromium
 * (`--host-resolver-rules`). Without that, the browser performs its own DNS
 * lookup at connect time, so a record that changes between validation and
 * navigation would slip past the private-address check.
 */
export async function resolveTargetUrl(rawUrl, cfg, { enforceAllowlist = true } = {}) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new TargetUrlError('目标地址不是有效 URL。');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TargetUrlError('目标地址只允许 http:// 或 https://。');
  }
  if (url.username || url.password) {
    throw new TargetUrlError('目标地址不能包含账号或密码。');
  }
  const hostname = normalizeHostname(url.hostname);
  const allowlist = cfg.targetUrlAllowlist ?? parseTargetUrlAllowlist();
  if (enforceAllowlist && !targetHostAllowed(hostname, allowlist)) {
    throw new TargetUrlError(`目标域名不在允许列表内：${hostname}`);
  }

  const literal = normalizeIpAddress(hostname);
  if (literal) {
    if (!cfg.targetUrlAllowPrivate && isPrivateIpAddress(literal.address)) {
      throw new TargetUrlError(`默认禁止访问私网或本机地址：${hostname}`);
    }
    // An IP literal needs no pinning: there is nothing left to resolve.
    return { url, hostname, addresses: [] };
  }

  const addresses = await resolveTargetHost(hostname);
  if (
    !cfg.targetUrlAllowPrivate &&
    addresses.some((entry) => isPrivateIpAddress(entry.address))
  ) {
    throw new TargetUrlError(`目标域名解析到私网或本机地址：${hostname}`);
  }
  return { url, hostname, addresses };
}

/**
 * Validates a target URL. `enforceAllowlist: false` still rejects private
 * addresses, which is what subresource requests use.
 */
export async function validateTargetUrl(rawUrl, cfg, options) {
  const { url } = await resolveTargetUrl(rawUrl, cfg, options);
  return url;
}

/**
 * Builds the Chromium `--host-resolver-rules` value that pins `hostname` to the
 * addresses validated above. Returns null when there is nothing to pin.
 */
export function buildResolverRules(hostname, addresses) {
  if (!hostname || !Array.isArray(addresses) || addresses.length === 0) return null;
  const rules = addresses
    .map((entry) => entry?.address)
    .filter(Boolean)
    .map((address) => `MAP ${hostname} ${address}`);
  return rules.length > 0 ? rules.join(', ') : null;
}
