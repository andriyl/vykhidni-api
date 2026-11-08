import { model } from '../gemini.js'

const MAX_HTML = 1800

const ALLOWED_ATTRIBUTES = new Set([
  'class',
  'id',
  'href',
  'src',
  'datetime',
  'content',
  'itemprop',
  'itemtype',
  'alt',
  'title',
  'data-src',
  'data-bg',
  'rel',
  'type',
  'value',
  'property',
  'name',
  'aria-label',
  'role'
])

/**
 * Trim HTML before sending it to the model: drop scripts, styles, svg,
 * iframe, inline handlers and noisy attributes, collapse whitespace.
 */
export function pruneHtml (html, max = MAX_HTML) {
  if (!html) return ''
  let value = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|iframe|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\s+on\w+="[^"]*"/gi, '')
    .replace(
      /\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)="[^"]*"/g,
      (match, name) =>
        ALLOWED_ATTRIBUTES.has(name.toLowerCase()) ? match : ''
    )
    .replace(
      /\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)='[^']*'/g,
      (match, name) =>
        ALLOWED_ATTRIBUTES.has(name.toLowerCase()) ? match : ''
    )
    .replace(/\s+/g, ' ')
    .trim()
  if (value.length > max) value = value.slice(0, max)
  return value
}

function extractJson (text) {
  if (!text) return null
  const cleaned = String(text).replace(/```json|```/gi, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }
}

const words = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null

function normalizeFields (value) {
  if (!value || typeof value !== 'object') return null
  const out = {}
  for (const [field, chain] of Object.entries(value)) {
    const items = (Array.isArray(chain) ? chain : [chain])
      .map(words)
      .filter(Boolean)
    if (items.length) out[field] = items
  }
  return Object.keys(out).length ? out : null
}

function normalizePagination (value) {
  if (!value || typeof value !== 'object') return null
  if (!['url', 'loadMore', 'none'].includes(value.mode)) return null

  const out = { mode: value.mode }
  for (const key of ['selector', 'param', 'text']) {
    const clean = words(value[key])
    if (clean) out[key] = clean
  }
  return out
}

function normalizeRecipe (parsed) {
  if (!parsed || typeof parsed !== 'object') return null

  const fields = normalizeFields(parsed.fields)
  const item = words(parsed.item)
  const link = normalizeFields({ link: parsed.link })?.link || null
  const pagination = normalizePagination(parsed.pagination)

  if (!item && !fields && !link && !pagination) return null
  return { item, link, fields, pagination }
}

function formatCandidates (candidates) {
  return candidates
    .map(
      (candidate, index) =>
        `--- КАНДИДАТ ${index + 1} ---\n` +
        `selector: ${candidate.selector}\n` +
        `count: ${candidate.count}\n` +
        `html: ${candidate.html}`
    )
    .join('\n\n')
}

async function callModel (prompt) {
  try {
    const response = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        temperature: 0.1
      }
    })
    const usage = response.response.usageMetadata || null
    return { data: extractJson(response.response.text()), usage }
  } catch (error) {
    console.warn('LLM discovery failed:', error.message)
    return { data: null, usage: null }
  }
}

const RECIPE_RULES = `
Правила:
- "item" мусить бути ТОЧНО одним із наданих selector кандидатів. Не вигадуй новий.
- "link" — селектор посилання всередині картки.
- "fields" — CSS-селектори відносно кореня картки. Для кожного поля 1–2 селектори.
- Дата/час: шукай itemprop="startDate", time[datetime], meta[content].
- Картинка: [itemprop="image"], meta[content], img.
- Не вигадуй селекторів, яких немає у фрагменті HTML.
- "pagination" вибирай лише з наданих варіантів або {"mode":"none"}.
`

const RECIPE_FIELDS =
  '"item":"...","link":["..."],"fields":{"title":["..."],"date":["..."],"time":["..."],"image":["..."],"location":["..."],"description":["..."],"price":["..."]}'

/**
 * Ask Gemini to choose the card selector and map fields from the candidates
 * collected by probeListing. Returns { data, usage }.
 */
export async function proposeRecipe ({
  url,
  title,
  candidates = [],
  pagination = [],
  structured = {}
} = {}) {
  const prompt = `Ти — експерт з веб-скрапінгу афіш подій.
Сторінка: ${url}
Заголовок: ${title || '—'}
Структуровані дані: ${JSON.stringify(structured)}

Нижче — кандидати карток подій та фрагменти їхнього HTML.

${formatCandidates(candidates)}

Кандидати пагінації:
${JSON.stringify(pagination)}
${RECIPE_RULES}
Поверни ТІЛЬКИ валідний JSON:
{${RECIPE_FIELDS},"pagination":{"mode":"url|loadMore|none","selector":"...","param":"page","text":"..."}}`

  const result = await callModel(prompt)
  return { data: normalizeRecipe(result.data), usage: result.usage }
}

/**
 * Ask Gemini to repair a recipe that produced poor extraction results.
 * Returns { data, usage }.
 */
export async function repairRecipe ({
  cardHtml = '',
  sample = [],
  failures = [],
  current = {}
} = {}) {
  const prompt = `Ти — експерт з веб-скрапінгу афіш подій.
Поточний рецепт не витягує частину полів. Виправ його.

Поточний рецепт:
${JSON.stringify(current)}

Проблемні поля: ${failures.join(', ') || '—'}

Що вже витягнуто з карток:
${JSON.stringify(sample.slice(0, 3))}

HTML картки:
${cardHtml}
${RECIPE_RULES}
Поверни ТІЛЬКИ валідний JSON з виправленими полями:
{${RECIPE_FIELDS}}`

  const result = await callModel(prompt)
  return { data: normalizeRecipe(result.data), usage: result.usage }
}

/**
 * Ask Gemini for field selectors on a detail page when generic extraction
 * did not fill all fields. Returns { data, usage } where data.fields exists.
 */
export async function refineDetail ({
  detailHtml = '',
  currentFields = {},
  missingFields = []
} = {}) {
  const fields = missingFields.length
    ? missingFields
    : ['title', 'date', 'time', 'image', 'location', 'description']

  const prompt = `Ти — експерт з веб-скрапінгу. Нижче HTML сторінки однієї події.
Потрібно підібрати CSS-селектори для полів: ${fields.join(', ')}.

Поточні селектори (можуть бути частково правильні):
${JSON.stringify(currentFields)}

HTML сторінки:
${detailHtml}

Правила:
- Прості й стабільні селектори: класи, itemprop, атрибути. Уникай nth-child.
- Для кожного поля поверни масив з 1–2 селекторів.
- Не вигадуй селекторів, яких немає у фрагменті.

Поверни ТІЛЬКИ валідний JSON:
{"fields":{"title":["..."],"date":["..."],"time":["..."],"image":["..."],"location":["..."],"description":["..."]}}`

  const result = await callModel(prompt)
  const fieldsResult = normalizeFields(result.data?.fields)
  return {
    data: fieldsResult ? { fields: fieldsResult } : null,
    usage: result.usage
  }
}
