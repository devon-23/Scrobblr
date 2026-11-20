import { describe, expect, it } from 'vitest'
import { isLocalOrigin, isValidToken, newToken, tagUrl } from './tokens'

describe('newToken', () => {
  it('is 22 URL-safe characters that pass the database rule', () => {
    for (let i = 0; i < 200; i++) {
      const t = newToken()
      expect(t).toHaveLength(22)
      expect(isValidToken(t)).toBe(true)
    }
  })

  it('maps bytes to base64url without padding', () => {
    const allFF = newToken((a) => a.fill(0xff))
    expect(allFF).toBe('_____________________w')
    const bytes = [0xfb, 0xef, 0xbe, ...Array(13).fill(0)]
    expect(newToken((a) => (a.set(bytes), a))).toMatch(/^----/)
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => newToken()))
    expect(seen.size).toBe(1000)
  })
})

describe('isValidToken', () => {
  it('matches the database check', () => {
    expect(isValidToken('AbCdEfGhIjKlMnOp')).toBe(true) // 16
    expect(isValidToken('a'.repeat(64))).toBe(true)
    expect(isValidToken('a'.repeat(15))).toBe(false)
    expect(isValidToken('a'.repeat(65))).toBe(false)
    expect(isValidToken('has space in it!!!')).toBe(false)
    expect(isValidToken('abc/def/ghi/jklmno')).toBe(false)
  })
})

describe('tagUrl', () => {
  it('builds the sticker URL', () => {
    expect(tagUrl('https://scrobblr.example.workers.dev', 'tok')).toBe('https://scrobblr.example.workers.dev/t/tok')
    expect(tagUrl('https://x.dev/', 'tok')).toBe('https://x.dev/t/tok')
  })

  it('fits on an NTAG213 (144 bytes) with room for NDEF overhead', () => {
    const url = tagUrl('https://scrobblr.cbark1313.workers.dev', newToken())
    // NDEF stores "https://" as a 1-byte prefix code; record + TLV headers are under 10 bytes.
    expect(url.length - 'https://'.length + 1 + 10).toBeLessThan(144)
  })
})

describe('isLocalOrigin', () => {
  it('flags addresses a phone tapping a sticker could not reach', () => {
    expect(isLocalOrigin('http://localhost:5173')).toBe(true)
    expect(isLocalOrigin('http://127.0.0.1:5173')).toBe(true)
    expect(isLocalOrigin('http://192.168.1.20:5173')).toBe(true)
    expect(isLocalOrigin('https://scrobblr.cbark1313.workers.dev')).toBe(false)
  })
})
