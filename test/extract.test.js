import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cleanDate,
  cleanTime,
  normalizeActions,
  normalizeEvent,
  splitDateTime
} from '../src/scanner/extract.js'

test('normalizeEvent resolves relative event URL and image', () => {
  const event = normalizeEvent(
    { title: '  Вистава  ', url: '/events/1', image: '/img/a.jpg' },
    'https://example.com/list'
  )

  assert.equal(event.title, 'Вистава')
  assert.equal(event.url, 'https://example.com/events/1')
  assert.equal(event.image, 'https://example.com/img/a.jpg')
})

test('normalizeEvent keeps absolute image URLs', () => {
  const event = normalizeEvent(
    { image: 'https://cdn.example.com/a.jpg?utm_source=x&q=1' },
    'https://example.com/list'
  )

  assert.equal(event.image, 'https://cdn.example.com/a.jpg?q=1')
})

test('normalizeEvent splits ISO date and time', () => {
  const event = normalizeEvent({ date: '2025-10-29T18:30:00' })

  assert.equal(event.date, '2025-10-29')
  assert.equal(event.time, '18:30')
})

test('normalizeEvent extracts a date from noisy text', () => {
  assert.equal(
    normalizeEvent({ date: 'Презентація 29/10/2025' }).date,
    '29/10/2025'
  )
})

test('cleanTime rejects a date in the time field', () => {
  assert.equal(cleanTime('29.10.2025'), '')
  assert.equal(cleanTime('19:00'), '19:00')
  assert.equal(cleanTime('19:00 - 21:00'), '19:00 - 21:00')
})

test('cleanDate leaves a value without a date untouched', () => {
  assert.equal(cleanDate('10:00'), '10:00')
})

test('splitDateTime supports ISO, date-only and time-only values', () => {
  assert.deepEqual(splitDateTime('2025-10-29T18:30'), {
    date: '2025-10-29',
    time: '18:30'
  })
  assert.deepEqual(splitDateTime('2025-10-29'), {
    date: '2025-10-29',
    time: ''
  })
  assert.deepEqual(splitDateTime('9:05'), { date: '', time: '09:05' })
  assert.equal(splitDateTime('29.10'), null)
})

test('normalizeActions flattens legacy extractDetails fields', () => {
  const actions = normalizeActions([
    {
      type: 'extractDetails',
      source: 'auto',
      fields: { title: 'h1', date: 'time' }
    }
  ])

  assert.equal(actions[0].title, 'h1')
  assert.equal(actions[0].date, 'time')
  assert.equal(actions[0].fields, undefined)
})

test('normalizeActions keeps new-format extractDetails fields nested', () => {
  const detail = {
    type: 'extractDetails',
    source: 'auto',
    fields: { title: 'h1' }
  }
  const actions = normalizeActions([
    { type: 'extractListItems', item: '.card' },
    detail
  ])

  assert.deepEqual(actions[1], detail)
})
