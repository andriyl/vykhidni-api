import test from 'node:test'
import assert from 'node:assert/strict'
import { toUnix } from '../src/utils.js'

const YEAR = new Date().getFullYear()

function localUnix (year, month, day, hours = 0, minutes = 0) {
  return Math.floor(new Date(year, month - 1, day, hours, minutes).getTime() / 1000)
}

test('toUnix parses ISO dates with time', () => {
  assert.equal(
    toUnix('2025-10-29T18:30'),
    localUnix(2025, 10, 29, 18, 30)
  )
})

test('toUnix parses DD.MM.YYYY with a separate time', () => {
  assert.equal(
    toUnix('29.10.2025', '18:30'),
    localUnix(2025, 10, 29, 18, 30)
  )
})

test('toUnix parses DD.MM without a year using the current year', () => {
  assert.equal(
    toUnix('29.10'),
    localUnix(YEAR, 10, 29)
  )
})

test('toUnix parses DD.MM without a year and with a time', () => {
  assert.equal(
    toUnix('29.10', '18:30'),
    localUnix(YEAR, 10, 29, 18, 30)
  )
})

test('toUnix does not treat a dot date as a time', () => {
  assert.equal(toUnix('29.10'), localUnix(YEAR, 10, 29, 0, 0))
})

test('toUnix parses Ukrainian month names', () => {
  assert.equal(
    toUnix('29 жовтня 2025', '12:00'),
    localUnix(2025, 10, 29, 12, 0)
  )
})

test('toUnix rejects impossible calendar dates', () => {
  assert.equal(toUnix('31.02.2026'), null)
})

test('toUnix returns null for empty or unrecognised values', () => {
  assert.equal(toUnix(''), null)
  assert.equal(toUnix('не дата'), null)
  assert.equal(toUnix(null, null), null)
})
