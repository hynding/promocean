import { describe, expect, it } from 'vitest'
import { suggestEventType } from '../src/index.js'

const registered = ['lesson_completed', 'profile_completed', 'signup']

describe('suggestEventType', () => {
  it('returns the exact match (distance 0)', () => {
    expect(suggestEventType('signup', registered)).toBe('signup')
  })
  it('returns a distance-1 match', () => {
    expect(suggestEventType('signu', registered)).toBe('signup') // deletion
    expect(suggestEventType('signupp', registered)).toBe('signup') // insertion
  })
  it('returns a distance-2 match', () => {
    expect(suggestEventType('xsignupx', registered)).toBe('signup') // insertion at both ends, distance 2
  })
  it('returns null when the closest match exceeds distance 2', () => {
    expect(suggestEventType('completely_unrelated_string', registered)).toBeNull()
  })
  it('returns null for an empty registered list', () => {
    expect(suggestEventType('signup', [])).toBeNull()
  })
  it('breaks ties by registered-list order (lowest index wins)', () => {
    // 'lesson_completed' and 'profile_completed' are both distance 1 from a crafted input? Use
    // two entries with identical edit distance to a common typo to exercise tie-break order.
    const list = ['aaaa', 'aaab']
    expect(suggestEventType('aaac', list)).toBe('aaaa') // distance 1 to both; first in list wins
    expect(suggestEventType('aaac', [...list].reverse())).toBe('aaab') // order flips the winner
  })
})
