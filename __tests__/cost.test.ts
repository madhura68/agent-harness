import { describe, expect, it } from 'vitest'
import { costToNanos, formatNanos, parseCeilingNanos } from '../src/cost.js'

describe('costToNanos', () => {
  it.each([
    [0, 0n],
    [1e-7, 100n],
    [0.000123, 123000n],
    [0.1, 100000000n],
    [1.5e-10, 1n], // only digits after the ninth decimal round up
    [1, 1000000000n],
    [12.5, 12500000000n],
    [1e21, 1000000000000000000000000000000n], // String(1e21) is '1e+21': an exponent form that is written out
    [1e-9, 1n],
    [1.0000000001, 1000000001n],
  ])('turns %s into %s nanos', (n, nanos) => {
    expect(costToNanos(n)).toBe(nanos)
  })

  it('never goes through n * 1e9 in floats (Math.ceil(0.000123 * 1e9) is 123001)', () => {
    expect(Math.ceil(0.000123 * 1e9)).toBe(123001)
    expect(costToNanos(0.000123)).toBe(123000n)
  })

  it.each([[NaN], [Infinity], [-Infinity], [-1], [-1e-12]])('refuses %s', (n) => {
    expect(() => costToNanos(n)).toThrow(RangeError)
  })
})

describe('parseCeilingNanos', () => {
  it.each([
    ['0.05', 50000000n],
    ['0.50', 500000000n],
    ['1', 1000000000n],
    ['0', 0n],
    ['12.345678901', 12345678901n],
    ['0.0000000001', 0n], // more than 9 decimals: rounded down, the stricter limit
    ['0.1234567899999', 123456789n],
  ])('reads %s as %s nanos', (s, nanos) => {
    expect(parseCeilingNanos(s)).toBe(nanos)
  })

  it.each([[''], ['.5'], ['5.'], ['1e-2'], ['-1'], ['+1'], [' 1'], ['1 '], ['1\n'], ['0x10'], ['1,5'], ['٣']])('refuses %j', (s) => {
    expect(() => parseCeilingNanos(s)).toThrow()
  })
})

describe('formatNanos', () => {
  it.each([
    [0n, '0.000000000'],
    [1n, '0.000000001'],
    [123000n, '0.000123000'],
    [600000000n, '0.600000000'],
    [1500000000n, '1.500000000'],
    [12345678901n, '12.345678901'],
  ])('writes %s as %s', (b, text) => {
    expect(formatNanos(b)).toBe(text)
  })

  it('refuses a negative amount', () => {
    expect(() => formatNanos(-1n)).toThrow(RangeError)
  })
})
