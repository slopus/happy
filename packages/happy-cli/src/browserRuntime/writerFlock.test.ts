import { describe, expect, it } from 'vitest'
import { procLocksHoldFlock } from './writerFlock'

const locks = [
    '1: POSIX  ADVISORY  WRITE 812 00:1f:3300 0 EOF',
    '2: FLOCK  ADVISORY  READ  4242 00:2e:9001 0 EOF',
    '3: FLOCK  ADVISORY  WRITE 4242 00:2e:9002 0 EOF',
    '4: -> FLOCK  ADVISORY  WRITE 5151 00:2e:9001 0 EOF',
].join('\n')

describe('procLocksHoldFlock', () => {
    it('finds an exclusive flock held by this pid on the lock file inode', () => {
        expect(procLocksHoldFlock(locks, 4242, 9002)).toBe(true)
    })

    it('ignores shared locks, POSIX locks, blocked waiters and other processes', () => {
        expect(procLocksHoldFlock(locks, 4242, 9001)).toBe(false)
        expect(procLocksHoldFlock(locks, 812, 3300)).toBe(false)
        expect(procLocksHoldFlock(locks, 5151, 9001)).toBe(false)
        expect(procLocksHoldFlock('', 4242, 9002)).toBe(false)
    })
})
