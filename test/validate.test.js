import test from 'node:test'
import assert from 'node:assert/strict'
import { validateEvents } from '../src/discovery/validate.js'

function isoDate (offsetDays) {
  const date = new Date()
  date.setDate(date.getDate() + offsetDays)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

test('validateEvents scores a complete future event highly', () => {
  const report = validateEvents([
    {
      title: 'Дитяча вистава',
      date: isoDate(3),
      time: '12:00',
      location: 'Львів',
      description: 'Опис події',
      image: 'https://example.com/a.jpg',
      url: 'https://example.com/events/1'
    }
  ])

  assert.equal(report.total, 1)
  assert.equal(report.unique, 1)
  assert.equal(report.dateRate, 1)
  assert.equal(report.futureRate, 1)
  assert.ok(report.score > 0.9)
})

test('validateEvents reports missing fields and empty input', () => {
  const empty = validateEvents([])
  assert.equal(empty.total, 0)
  assert.equal(empty.score, 0)
  assert.ok(empty.issues.includes('Не знайдено жодної події'))

  const incomplete = validateEvents([
    { title: 'Х', url: 'https://example.com/1' }
  ])
  assert.equal(incomplete.fill.title, 0)
  assert.ok(incomplete.score < 0.5)
  assert.ok(incomplete.issues.some((issue) => issue.includes('title')))
})

test('validateEvents penalises duplicate URLs', () => {
  const report = validateEvents([
    { title: 'Подія один', url: 'https://example.com/1' },
    { title: 'Подія два', url: 'https://example.com/1' }
  ])

  assert.equal(report.total, 2)
  assert.equal(report.unique, 1)
  assert.ok(report.issues.some((issue) => issue.includes('Дублікати URL')))
})

test('validateEvents treats non-array input as an empty list', () => {
  const report = validateEvents(null)
  assert.equal(report.total, 0)
  assert.equal(report.score, 0)
})
