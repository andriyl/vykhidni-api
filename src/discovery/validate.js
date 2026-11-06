import { toUnix } from '../utils.js'

const WEIGHTS = {
  title: 0.3,
  date: 0.3,
  image: 0.2,
  location: 0.15,
  description: 0.05
}

function isPlausibleTitle (value) {
  if (!value || typeof value !== 'string') return false
  if (value.length < 3 || value.length > 300) return false
  return !/^https?:\/\//i.test(value)
}

/**
 * Перевірка якості витягнутих подій: заповнюваність полів, дублікати, наявність дати.
 * Повертає оцінку confidence та список зауважень.
 */
export function validateEvents (events, { now = Date.now() } = {}) {
  const list = Array.isArray(events) ? events : []
  const total = list.length
  const unique = new Set(list.map((event) => event.url).filter(Boolean)).size

  const fill = {}
  for (const field of Object.keys(WEIGHTS)) {
    const filled = list.filter((event) => {
      if (field === 'title') return isPlausibleTitle(event.title)
      return Boolean(event[field] && String(event[field]).trim().length > 1)
    }).length
    fill[field] = total ? +(filled / total).toFixed(3) : 0
  }

  let parsedDates = 0
  let future = 0
  const nowSeconds = Math.floor(now / 1000)
  for (const event of list) {
    const unix = toUnix(event.date, event.time)
    if (unix) {
      parsedDates += 1
      if (unix >= nowSeconds) future += 1
    }
  }

  const dateRate = total ? +(parsedDates / total).toFixed(3) : 0
  const futureRate = parsedDates ? +(future / parsedDates).toFixed(3) : 0

  let score = 0
  for (const [field, weight] of Object.entries(WEIGHTS)) {
    score += weight * fill[field]
  }
  if (total && unique / total < 0.9) score *= 0.6
  if (dateRate < 0.6) score *= 0.75
  score = +Math.min(1, score).toFixed(3)

  const issues = []
  if (!total) issues.push('Не знайдено жодної події')
  if (total > 1 && unique < total) {
    issues.push(`Дублікати URL: ${total - unique} з ${total}`)
  }
  if (fill.title < 0.9) issues.push(`title заповнено у ${Math.round(fill.title * 100)}%`)
  if (dateRate < 0.8) issues.push(`дата парситься у ${Math.round(dateRate * 100)}%`)
  if (fill.image < 0.5) issues.push(`image заповнено у ${Math.round(fill.image * 100)}%`)
  if (parsedDates && futureRate === 0) {
    issues.push('Усі дати в минулому — можливо, це архів, а не афіша')
  }

  return {
    total,
    unique,
    fill,
    dateRate,
    futureRate,
    score,
    issues,
    preview: list.slice(0, 8)
  }
}
