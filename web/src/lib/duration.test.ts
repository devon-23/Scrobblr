import { describe, expect, it } from 'vitest'
import { formatDuration, parseDuration } from './duration'

describe('formatDuration', () => {
  it.each([
    [225, '3:45'],
    [59, '0:59'],
    [3723, '1:02:03'],
    [null, '–:––'],
  ])('%s → %s', (input, expected) => expect(formatDuration(input)).toBe(expected))
})

describe('parseDuration', () => {
  it.each([
    ['3:45', 225],
    ['03:45', 225],
    ['225', 225],
    ['1:02:03', 3723],
    ['', null],
    ['   ', null],
    ['3:75', undefined],
    ['abc', undefined],
    ['0', undefined],
    ['0:00', undefined],
  ])('%j → %s', (input, expected) => expect(parseDuration(input)).toBe(expected))
})
