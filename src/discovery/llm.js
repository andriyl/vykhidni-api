import { callLLM } from '../providers.js'

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

export function extractJson (text) {
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

async function callModel (prompt) {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await callLLM(prompt)
    if (result.text) {
      return { data: extractJson(result.text), usage: result.usage }
    }
    const message = result.error || ''
    const retryable = /503|429|Service Unavailable|high demand|quota|exhausted/i.test(message)
    console.warn(`LLM attempt ${attempt}/${maxAttempts} failed: ${message}`)
    if (!retryable || attempt === maxAttempts) {
      return { data: null, usage: null }
    }
    const delay = /429/i.test(message) ? 13000 : 1000 * attempt
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  return { data: null, usage: null }
}

const SELECTOR_RULES = `Правила вибору селекторів:
- Використовуй лише селектори, що реально є у поданому HTML; не вигадуй класи чи теги.
- Для кожного поля — каскад від найконкретнішого до найзагальнішого, наприклад ["h1", "[itemprop='name']"]. Якщо підходящого селектора немає — null.
- Шукай за вмістом, а не лише за назвою класу: HH:mm — час, формат дати — дата, адреса — місце, довший текст — опис.
- Для location бери блок адреси/місця, не organizer і не навігацію.
- Для description — до 5 селекторів, для решти полів — 1–2. Уникай nth-child.
- Кожен селектор стосується саме цієї події/картки, а не сусідніх блоків.
- Відповідь — ТІЛЬКИ валідний JSON у вказаному форматі, без пояснень.`

/**
 * Ask the LLM provider for field selectors on a detail page. Returns { data, usage } where data.fields exists.
 */
export async function refineDetail ({
  detailHtml = '',
  currentFields = {},
  missingFields = [],
  rejectedFields = {}
} = {}) {
  const fields = missingFields.length
    ? missingFields
    : ['title', 'date', 'time', 'image', 'location', 'description']

  const prompt = `Ти — експерт з веб-скрапінгу. Нижче HTML сторінки однієї події (може бути скорочений).
Підбери CSS-селектори для полів: ${fields.join(', ')}.
ОБОВ'ЯЗКОВО поверни селектор для КОЖНОГО з перелічених полів, навіть якщо значення вже є.

Для "description" — до 5 селекторів різних блоків, які разом дають повний опис: основний текст, деталі, ціну, вік, тривалість. Не включай навігацію, футер, меню, блоки інших подій і блоки лише з датою/адресою/кнопками.

${SELECTOR_RULES}

Поточні селектори (можуть бути частково правильні):
${JSON.stringify(currentFields)}

Селектори, які не знайшли жодного елемента (не повторюй їх):
${JSON.stringify(rejectedFields)}

HTML сторінки:
${detailHtml}

Формат:
{"fields":{"title":["..."],"date":["..."],"time":["..."],"image":["..."],"location":["..."],"description":["...","..."]}}`

  const result = await callModel(prompt)
  const fieldsResult = normalizeFields(result.data?.fields)
  return {
    data: fieldsResult ? { fields: fieldsResult } : null,
    usage: result.usage
  }
}

/**
 * Запропонувати селектори списку подій (item, link, fields, pagination) за HTML.
 */
export async function proposeListRecipe ({ html = '', structured = {}, rejected = [] } = {}) {
  const prompt = `Ти — експерт з веб-скрапінгу афіш подій. Нижче HTML сторінки зі списком подій. Структуровані дані: ${JSON.stringify(structured)}.

Підбери:
- "item" — CSS-селектор картки однієї події (повторюваний елемент).
- "link" — селектор посилання всередині картки.
- "fields" — CSS-селектори відносно кореня картки для полів: title, date, time, image, location, description, price.
- "pagination" — пагінація: {"mode":"url|loadMore|none", "selector":"...", "param":"page", "text":"..."}.

${SELECTOR_RULES}

Селектори, які не знайшли жодного елемента (не повторюй їх):
${JSON.stringify(rejected)}

HTML:
${html}

Формат:
{"item":"...","link":["..."],"fields":{"title":["..."],"date":["..."],"time":["..."],"image":["..."],"location":["..."],"description":["..."],"price":["..."]},"pagination":{"mode":"url|loadMore|none","selector":"...","param":"page","text":"..."}}`

  const result = await callModel(prompt)
  const data = normalizeRecipe(result.data)
  if (!data || !data.item) return { data: null, usage: result.usage }
  return { data, usage: result.usage }
}

/**
 * Класифікувати події: чи призначені вони для дітей. Один запит на весь батч.
 * Повертає масив boolean тієї ж довжини або null при помилці.
 */
export async function classifyEventsForKids (events = []) {
  if (!Array.isArray(events) || !events.length) return []
  const items = events.map((e, i) => ({
    i,
    title: String(e?.title || '').slice(0, 200),
    date: String(e?.date || '').slice(0, 40),
    location: String(e?.location || '').slice(0, 120),
    description: String(e?.description || '').slice(0, 300)
  }))
  const prompt = `Ти класифікуєш події: чи призначені вони для дітей (або для сімей з дітьми).
Для кожної події поверни true, якщо подія для дітей, false — якщо для дорослих/загальна/18+.
Події:
${JSON.stringify(items)}
Поверни ТІЛЬКИ валідний JSON:
{"results":[true,false,...]} — масив boolean у тому ж порядку, що й події.`

  try {
    const result = await callLLM(prompt)
    if (!result.text) return null
    const parsed = extractJson(result.text)
    const results = parsed?.results
    if (!Array.isArray(results) || results.length !== events.length) return null
    return results.map((v) => Boolean(v))
  } catch (error) {
    console.warn('LLM classify failed:', error?.message)
    return null
  }
}
