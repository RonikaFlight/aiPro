/**
 * SafeTargetUrlService — ProofPilot
 *
 * CRITICAL SECURITY: every URL the scanner processes is treated as hostile.
 * Validates URL syntax, protocol, host, port, and resolves DNS to reject
 * private/internal/metadata IP ranges. Implements DNS rebinding protection.
 *
 * See SECURITY_MODEL.md §"SSRF controls" and THREAT_MODEL.md T9–T11.
 */
import { env } from './env'
import { logger } from './logger'
import { ForbiddenError } from './errors'

const BLOCKED_PROTOCOLS = new Set([
  'file:',
  'ftp:',
  'gopher:',
  'data:',
  'javascript:',
  'blob:',
  'chrome:',
  'chrome-extension:',
  'about:',
  'ws:',
  'wss:',
])

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443', '3000', '3001', '4000'])

/** IPv4 private/reserved ranges (CIDR). */
const IPV4_BLOCKED: Array<{ base: number; mask: number; label: string }> = (() => {
  const parse = (s: string) => {
    const [ip, bits] = s.split('/')
    const parts = ip.split('.').map(Number)
    const base = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
    const mask = bits === '0' ? 0 : (0xffffffff << (32 - bits)) >>> 0
    return { base, mask, label: s }
  }
  return [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10', // CGNAT
    '127.0.0.0/8',
    '169.254.0.0/16', // link-local
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24', // documentation
    '192.168.0.0/16',
    '198.18.0.0/15',
    '198.51.100.0/24', // documentation
    '203.0.113.0/24', // documentation
    '224.0.0.0/4', // multicast
    '240.0.0.0/4', // reserved
  ].map(parse)
})()

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata',
  'kubernetes.default.svc',
  'kubernetes.default.svc.cluster.local',
])

export interface SafeUrlResult {
  href: string
  origin: string
  protocol: string
  hostname: string
  port: string
  pathname: string
  search: string
  hash: string
  isLocalDev: boolean
}

export interface SafeUrlOptions {
  allowHttp?: boolean        // allow http:// (only in dev)
  allowLocalhost?: boolean   // allow localhost (only in dev)
  allowPrivateNetwork?: boolean // SCAN_PRIVATE_NETWORK_OVERRIDE — refused in prod
}

const DEFAULT_OPTS: SafeUrlOptions = {
  allowHttp: false,
  allowLocalhost: false,
  allowPrivateNetwork: false,
}

/** Normalize URL: parse, normalize hostname, validate. Throws on invalid. */
export function validateUrl(input: string, opts: SafeUrlOptions = DEFAULT_OPTS): SafeUrlResult {
  const options = { ...DEFAULT_OPTS, ...opts }
  if (typeof input !== 'string' || input.length === 0) {
    throw new ForbiddenError('URL must be a non-empty string')
  }
  if (input.length > 2048) {
    throw new ForbiddenError('URL exceeds maximum length')
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new ForbiddenError('Malformed URL')
  }

  // Reject embedded credentials
  if (url.username || url.password) {
    throw new ForbiddenError('URL must not contain credentials')
  }

  // Protocol check
  if (BLOCKED_PROTOCOLS.has(url.protocol)) {
    throw new ForbiddenError(`Blocked protocol: ${url.protocol}`)
  }

  // Allow https by default; allow http only if explicitly enabled
  if (url.protocol === 'https:') {
    // ok
  } else if (url.protocol === 'http:' && (options.allowHttp || env.SCAN_ALLOW_HTTP_LOCAL)) {
    // ok in dev
  } else {
    throw new ForbiddenError(`Protocol not allowed: ${url.protocol}`)
  }

  // Port check
  if (url.port && !ALLOWED_PORTS.has(url.port)) {
    throw new ForbiddenError(`Port not allowed: ${url.port}`)
  }

  // Hostname checks
  const hostname = url.hostname.toLowerCase().trim()
  if (hostname === '' || hostname === '[]') {
    throw new ForbiddenError('Invalid hostname')
  }

  // Reject hostname confusion / encoding tricks
  if (hostname.includes('\\') || hostname.includes('%00') || hostname.includes('..')) {
    throw new ForbiddenError('Hostname contains forbidden characters')
  }

  // Blocked hostnames
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    // localhost allowed only in dev
    if (hostname === 'localhost' && (options.allowLocalhost || env.DEV_ALLOW_LOCALHOST_TARGETS) && env.APP_ENV === 'development') {
      // ok in dev
    } else {
      throw new ForbiddenError(`Blocked hostname: ${hostname}`)
    }
  }

  // IPv4 literal checks
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number)
    if (octets.some((o) => o > 255)) {
      throw new ForbiddenError('Invalid IPv4 address')
    }
    const ipInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
    for (const range of IPV4_BLOCKED) {
      if ((ipInt & range.mask) >>> 0 === range.base) {
        if (options.allowPrivateNetwork && env.APP_ENV === 'development') {
          // ok in dev only
        } else {
          throw new ForbiddenError(`Blocked IP range: ${range.label}`)
        }
      }
    }
  }

  // IPv6 literal checks
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    const inner = hostname.slice(1, -1).toLowerCase()
    // ::1, ::, fc00::/7, fe80::/10, etc.
    if (
      inner === '::1' ||
      inner === '::' ||
      inner.startsWith('fc') ||
      inner.startsWith('fd') ||
      inner.startsWith('fe80') ||
      inner.startsWith('fe9') ||
      inner.startsWith('fea') ||
      inner.startsWith('feb')
    ) {
      if (options.allowPrivateNetwork && env.APP_ENV === 'development') {
        // ok in dev only
      } else {
        throw new ForbiddenError(`Blocked IPv6 address: ${inner}`)
      }
    }
    // IPv4-mapped IPv6 (::ffff:a.b.c.d)
    const mapped = inner.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    if (mapped) {
      throw new ForbiddenError('Blocked IPv4-mapped IPv6 address')
    }
  }

  // Hex / octal IP forms — reject
  if (/^0x[0-9a-f]+$/i.test(hostname)) {
    throw new ForbiddenError('Hex-encoded IP not allowed')
  }

  return {
    href: url.href,
    origin: url.origin,
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port,
    pathname: url.pathname,
    search: url.search,
    hash: url.hash,
    isLocalDev: hostname === 'localhost' && env.APP_ENV === 'development',
  }
}

/**
 * Validate a redirect target against an allowlist of origins.
 * Returns true if the redirect is allowed, false otherwise.
 */
export function isRedirectAllowed(
  redirectUrl: string,
  allowedOrigins: string[],
  visitedRedirects: string[],
): boolean {
  if (visitedRedirects.length >= 10) {
    logger.warn('Redirect chain too long', { count: visitedRedirects.length })
    return false
  }
  try {
    const url = new URL(redirectUrl)
    const origin = url.origin
    return allowedOrigins.includes(origin)
  } catch {
    return false
  }
}

/**
 * DNS rebinding protection.
 * Resolves hostname to IPs, returns them. The caller must:
 *   1. Resolve before connecting.
 *   2. Record approved IPs.
 *   3. Re-resolve before connecting.
 *   4. Abort if the host changes to an unsafe address.
 */
export async function resolveHostname(hostname: string): Promise<string[]> {
  // In Node 18+ / Bun, dns.promises.resolve4 returns IPv4 addresses.
  const dns = await import('dns').then((m) => m.promises)
  try {
    const [a, aaaa] = await Promise.allSettled([
      dns.resolve4(hostname),
      dns.resolve6(hostname),
    ])
    const ips: string[] = []
    if (a.status === 'fulfilled') ips.push(...a.value)
    if (aaaa.status === 'fulfilled') ips.push(...aaaa.value)
    return ips
  } catch {
    return []
  }
}

/** Check whether an IP is in a blocked range. */
export function isBlockedIp(ip: string): boolean {
  const ipv4Match = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map(Number)
    const ipInt = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
    return IPV4_BLOCKED.some((range) => (ipInt & range.mask) >>> 0 === range.base)
  }
  // IPv6 checks
  const lower = ip.toLowerCase()
  if (lower === '::1' || lower === '::') return true
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true
  if (lower.startsWith('fe80')) return true
  return false
}

/**
 * Validate target URL for a deep scan.
 * Combines all checks: URL syntax, protocol, IP, DNS rebinding.
 */
export async function validateScanTarget(
  input: string,
  allowedOrigins: string[],
  opts: SafeUrlOptions = DEFAULT_OPTS,
): Promise<SafeUrlResult> {
  const result = validateUrl(input, opts)

  // For deep scans, must be inside allowed verified origins
  if (!allowedOrigins.includes(result.origin)) {
    throw new ForbiddenError(`Target origin not in verified allowed origins: ${result.origin}`)
  }

  // Resolve and check IPs (DNS rebinding protection)
  if (!result.isLocalDev) {
    const ips = await resolveHostname(result.hostname)
    if (ips.length === 0) {
      throw new ForbiddenError('Could not resolve hostname')
    }
    for (const ip of ips) {
      if (isBlockedIp(ip)) {
        throw new ForbiddenError(`Resolved to blocked IP: ${ip}`)
      }
    }
    // Record approved IPs — caller should re-resolve before connecting
  }

  return result
}

/** Normalize a URL for fingerprinting (strip fragment, sort query, drop ignored params). */
export function normalizeUrl(input: string, ignoredParams: string[] = []): string {
  try {
    const url = new URL(input)
    url.hash = ''
    // Drop ignored params
    for (const p of ignoredParams) {
      url.searchParams.delete(p)
    }
    // Sort params
    const params = Array.from(url.searchParams.entries()).sort(([a], [b]) => a.localeCompare(b))
    url.search = ''
    for (const [k, v] of params) {
      url.searchParams.append(k, v)
    }
    // Lowercase host, remove default ports
    url.hostname = url.hostname.toLowerCase()
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = ''
    }
    return url.href
  } catch {
    return input
  }
}
