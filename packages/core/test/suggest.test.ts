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
  it('matches at exactly distance 2 and returns null at exactly distance 3 (boundary)', () => {
    const registeredList = ['level_complete']
    // 'level_complete' is 14 chars: l e v e l _ c o m p l e t e
    // Deleting the trailing 2 chars ('t','e') gives the 12-char prefix 'level_comple'.
    // A string and its own prefix differ by exactly the length difference: the lower bound
    // on edit distance is |lengths differ| (each op changes length by at most 1), and that
    // bound is achieved here via 2 plain deletions, so distance === 2 exactly (within <=2).
    expect(suggestEventType('level_comple', registeredList)).toBe('level_complete')
    // Deleting the trailing 3 chars ('e','t','e') gives the 11-char prefix 'level_compl'.
    // Same prefix argument: distance === 3 exactly, which exceeds the <=2 threshold, so null.
    expect(suggestEventType('level_compl', registeredList)).toBeNull()
  })
  it('breaks ties by registered-list order (lowest index wins)', () => {
    // 'lesson_completed' and 'profile_completed' are both distance 1 from a crafted input? Use
    // two entries with identical edit distance to a common typo to exercise tie-break order.
    const list = ['aaaa', 'aaab']
    expect(suggestEventType('aaac', list)).toBe('aaaa') // distance 1 to both; first in list wins
    expect(suggestEventType('aaac', [...list].reverse())).toBe('aaab') // order flips the winner
  })
})
