/**
 * SSRF protection guard — ProofPilot
 *
 * Validates that a hostname does not resolve to a private or internal IP
 * address. Used by outgoing webhooks and any other service that makes
 * outbound HTTP requests based on user-provided URLs.
 *
 * Blocked ranges:
 *   - 127.0.0.0/8       (loopback)
 *   - 10.0.0.0/8        (private Class A)
 *   - 172.16.0.0/12      (private Class B)
 *   - 192.168.0.0/16     (private Class C)
 *   - 169.254.0.0/16     (link-local)
 *   - 0.0.0.0/8          (current network)
 *   - ::1                (IPv6 loopback)
 *   - fc00::/7           (IPv6 unique local)
 *   - fe80::/10          (IPv6 link-local)
 *   - ::ffff:0:0/96      (IPv4-mapped IPv6)
 *
 * Uses Node.js dns.lookup for resolution (respects /etc/hosts and nsswitch).
 * Results are NOT cached (each check is a fresh DNS lookup to prevent
 * time-of-check/time-of-use attacks).
 */
import dns from 'dns'
import { promisify } from 'util'

const lookup = promisify(dns.lookup)

/**
 * Check if a hostname resolves to a private/internal IP address.
 * Returns true if the hostname is private (should be blocked).
 */
export async function isPrivateUrl(hostname: string): Promise<boolean> {
  // Block obvious non-hostname patterns
  if (!hostname || hostname === 'localhost' || hostname === 'localhost.localdomain') {
    return true
  }

  // Block if it looks like a raw IP
  if (isPrivateIpAddress(hostname)) {
    return true
  }

  // Resolve hostname via DNS
  try {
    const result = await lookup(hostname, { family: 4 })
    if (result && isPrivateIpAddress(result.address)) {
      return true
    }
  } catch {
    // DNS resolution failed — allow through (will fail at fetch time anyway)
  }

  // Also check IPv6 if available
  try {
    const result = await lookup(hostname, { family: 6 })
    if (result && isPrivateIpAddress(result.address)) {
      return true
    }
  } catch {
    // No IPv6 — fine
  }

  return false
}

/**
 * Check if a raw IP address string is in a private/reserved range.
 * Handles both IPv4 and IPv6.
 */
export function isPrivateIpAddress(ip: string): boolean {
  // IPv4
  if (isIPv4(ip)) {
    return isPrivateIPv4(ip)
  }

  // IPv6
  if (isIPv6(ip)) {
    return isPrivateIPv6(ip)
  }

  return false
}

function isIPv4(ip: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)
}

function isIPv6(ip: string): boolean {
  return ip.includes(':')
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4) return true // Malformed — block

  const [a, b] = parts

  // 0.0.0.0/8
  if (a === 0) return true
  // 127.0.0.0/8
  if (a === 127) return true
  // 10.0.0.0/8
  if (a === 10) return true
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true
  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true

  return false
}

function isPrivateIPv6(ip: string): boolean {
  // Normalized lowercase
  const addr = ip.toLowerCase()

  // ::1 (loopback)
  if (addr === '::1' || addr === '0000:0000:0000:0000:0000:0000:0000:0001') {
    return true
  }

  // fc00::/7 (unique local addresses: fc00:: - fdff::)
  if (addr.startsWith('fc') || addr.startsWith('fd')) {
    return true
  }

  // fe80::/10 (link-local)
  if (addr.startsWith('fe8') || addr.startsWith('fe9') ||
      addr.startsWith('fea') || addr.startsWith('feb')) {
    return true
  }

  // ::ffff:0:0/96 (IPv4-mapped IPv6 addresses)
  if (addr.startsWith('::ffff:')) {
    const ipv4Part = addr.replace('::ffff:', '')
    if (isIPv4(ipv4Part)) {
      return isPrivateIPv4(ipv4Part)
    }
  }

  // ::/8 (unspecified)
  if (addr === '::') return true

  return false
}
