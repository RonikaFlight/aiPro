/**
 * Unit tests for src/lib/ssrf-guard.ts
 *
 * Tests the pure `isPrivateIpAddress()` function and the async `isPrivateUrl()`.
 */
import { describe, test, expect } from 'bun:test'
import { isPrivateIpAddress } from '../ssrf-guard'

// ─── isPrivateIpAddress ─────────────────────────────────────────────────────

describe('isPrivateIpAddress()', () => {
  // ─── IPv4 Private ranges ─────────────────────────────────────────────────

  describe('IPv4 private ranges', () => {
    test('127.0.0.1 (loopback) is private', () => {
      expect(isPrivateIpAddress('127.0.0.1')).toBe(true)
    })

    test('127.0.0.2 is private', () => {
      expect(isPrivateIpAddress('127.0.0.2')).toBe(true)
    })

    test('10.0.0.1 (Class A private) is private', () => {
      expect(isPrivateIpAddress('10.0.0.1')).toBe(true)
    })

    test('10.255.255.255 is private', () => {
      expect(isPrivateIpAddress('10.255.255.255')).toBe(true)
    })

    test('172.16.0.1 (Class B private start) is private', () => {
      expect(isPrivateIpAddress('172.16.0.1')).toBe(true)
    })

    test('172.31.255.255 (Class B private end) is private', () => {
      expect(isPrivateIpAddress('172.31.255.255')).toBe(true)
    })

    test('172.15.255.255 (below Class B private) is NOT private', () => {
      expect(isPrivateIpAddress('172.15.255.255')).toBe(false)
    })

    test('172.32.0.1 (above Class B private) is NOT private', () => {
      expect(isPrivateIpAddress('172.32.0.1')).toBe(false)
    })

    test('192.168.1.1 (Class C private) is private', () => {
      expect(isPrivateIpAddress('192.168.1.1')).toBe(true)
    })

    test('192.168.0.1 is private', () => {
      expect(isPrivateIpAddress('192.168.0.1')).toBe(true)
    })

    test('169.254.0.1 (link-local) is private', () => {
      expect(isPrivateIpAddress('169.254.0.1')).toBe(true)
    })

    test('169.254.169.254 (AWS metadata) is private', () => {
      expect(isPrivateIpAddress('169.254.169.254')).toBe(true)
    })

    test('0.0.0.0 (current network) is private', () => {
      expect(isPrivateIpAddress('0.0.0.0')).toBe(true)
    })

    test('0.1.2.3 is private', () => {
      expect(isPrivateIpAddress('0.1.2.3')).toBe(true)
    })
  })

  // ─── IPv4 Public ─────────────────────────────────────────────────────────

  describe('IPv4 public addresses', () => {
    test('8.8.8.8 (Google DNS) is NOT private', () => {
      expect(isPrivateIpAddress('8.8.8.8')).toBe(false)
    })

    test('1.1.1.1 (Cloudflare DNS) is NOT private', () => {
      expect(isPrivateIpAddress('1.1.1.1')).toBe(false)
    })

    test('172.1.1.1 is NOT private', () => {
      expect(isPrivateIpAddress('172.1.1.1')).toBe(false)
    })

    test('192.169.1.1 is NOT private', () => {
      expect(isPrivateIpAddress('192.169.1.1')).toBe(false)
    })

    test('203.0.113.1 is NOT private', () => {
      expect(isPrivateIpAddress('203.0.113.1')).toBe(false)
    })
  })

  // ─── IPv6 ──────────────────────────────────────────────────────────────────

  describe('IPv6 addresses', () => {
    test('::1 (loopback) is private', () => {
      expect(isPrivateIpAddress('::1')).toBe(true)
    })

    test(':: (unspecified) is private', () => {
      expect(isPrivateIpAddress('::')).toBe(true)
    })

    test('0000:...:0001 (full form loopback) is private', () => {
      expect(isPrivateIpAddress('0000:0000:0000:0000:0000:0000:0000:0001')).toBe(true)
    })

    test('fc00::1 (ULA) is private', () => {
      expect(isPrivateIpAddress('fc00::1')).toBe(true)
    })

    test('fd00::1 (ULA) is private', () => {
      expect(isPrivateIpAddress('fd00::1')).toBe(true)
    })

    test('fe80::1 (link-local) is private', () => {
      expect(isPrivateIpAddress('fe80::1')).toBe(true)
    })

    test('fe9a::1 (link-local extended) is private', () => {
      expect(isPrivateIpAddress('fe9a::1')).toBe(true)
    })

    test('fea0::1 (link-local extended) is private', () => {
      expect(isPrivateIpAddress('fea0::1')).toBe(true)
    })

    test('feb0::1 (link-local extended) is private', () => {
      expect(isPrivateIpAddress('feb0::1')).toBe(true)
    })

    test('::ffff:127.0.0.1 (IPv4-mapped IPv6 loopback) is private', () => {
      expect(isPrivateIpAddress('::ffff:127.0.0.1')).toBe(true)
    })

    test('::ffff:10.0.0.1 (IPv4-mapped IPv6 private) is private', () => {
      expect(isPrivateIpAddress('::ffff:10.0.0.1')).toBe(true)
    })

    test('::ffff:192.168.1.1 (IPv4-mapped IPv6 private) is private', () => {
      expect(isPrivateIpAddress('::ffff:192.168.1.1')).toBe(true)
    })

    test('::ffff:8.8.8.8 (IPv4-mapped public) is NOT private', () => {
      expect(isPrivateIpAddress('::ffff:8.8.8.8')).toBe(false)
    })

    test('2001:4860:4860::8888 (Google public) is NOT private', () => {
      expect(isPrivateIpAddress('2001:4860:4860::8888')).toBe(false)
    })
  })

  // ─── Edge cases ───────────────────────────────────────────────────────────

  describe('edge cases', () => {
    test('non-IP string returns false', () => {
      expect(isPrivateIpAddress('not-an-ip')).toBe(false)
    })

    test('empty string returns false', () => {
      expect(isPrivateIpAddress('')).toBe(false)
    })

    test('IPv4 with 3 parts does not match IPv4 regex — returns false', () => {
      // 3-part "IP" doesn't match the IPv4 regex, so isIPv4 returns false,
      // isIPv6 returns false (no colon), so the function returns false.
      expect(isPrivateIpAddress('192.168.1')).toBe(false)
    })
  })
})
