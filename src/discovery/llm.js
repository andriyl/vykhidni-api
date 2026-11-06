import { model } from '../gemini.js'

const MAX_SNIPPET = 9000

/**
 * Trim HTML before sending it to the model: drop scripts, styles, svg,
 * inline styles and noisy attributes, collapse whitespace.
 */
export function pruneHtml (html, max = MAX_SNIPPET) {
  if (!html) return ''
  let value = String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/\sstyle="[^"]*"/gi, '')
    .replace(/\s(?:srcset|sizes|loading|decoding|class="[^"]{80,}")\s*=\s*"[^"]*"/gi, ' ')
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

function normalizeFields (value) {
  if (!value || typeof value !== 'object') return null
  const out = {}
  for (const [field, chain] of Object.entries(value)) {
    if (typeof chain === 'string') out[field] = [chain]
    else if (Array.isArray(chain)) {
      const clean = chain.filter((item) => typeof item === 'string' && item.trim())
      if (clean.length) out[field] = clean
    }
  }
  return Object.keys(out).length ? out : null
}

/**
 * Ask Gemini to propose CSS selector chains for the given fields.
 * Returns { item?, link?, fields? } or null.
 */
export async function refineWithLLM ({
  itemSnippets = [],
  detailSnippet = '',
  currentFields = {},
  missingFields = [],
  kind = 'listing'
} = {}) {
  const fields = missingFields.length
    ? missingFields
    : ['title', 'date', 'time', 'image', 'location', 'description']

  const prompt = `Ти — експерт з веб-скрапінгу. Тобі дано фрагменти HTML сторінки з подіями.
Потрібно підібрати CSS-селектори (відносно кореня картки) для полів: ${fields.join(', ')}.
${kind === 'listing' ? 'Також визнач селектор самої картки події (item) та селектор посилання (link).' : ''}

Правила:
- Селектори мають бути прості й стабільні: класи, itemprop, атрибути. Уникай nth-child та довгих ланцюгів.
- Для кожного поля поверни масив з 1–2 селекторів (перший — основний, другий — fallback).
- Дата/час: шукай itemprop="startDate", time[datetime], meta[content].
- Картинка: [itemprop="image"], meta[content], img.
- Не вигадуй селекторів, яких немає у фрагменті.

Поточні селектори (можуть бути частково правильні):
${JSON.stringify(currentFields)}

${itemSnippets
  .map((snippet, index) => `--- КАРТКА ${index + 1} ---\n${snippet}`)
  .join('\n')}

${detailSnippet ? `--- СТОРІНКА ПОДІЇ ---\n${detailSnippet}` : ''}

Відповідай ТІЛЬКИ валідним JSON у форматі:
{"fields":{"title":["..."],"date":["..."],"time":["..."],"image":["..."],"location":["..."],"description":["..."]}${
    kind === 'listing' ? ',"item":"...","link":["..."]' : ''
  }}`

  try {
    const response = await model.generateContent(prompt)
    const parsed = extractJson(response.response.text())
    if (!parsed) return null

    const normalized = {
      fields: normalizeFields(parsed.fields),
      item: typeof parsed.item === 'string' ? parsed.item.trim() : null,
      link: normalizeFields({ link: parsed.link })?.link || null
    }

    if (!normalized.fields && !normalized.item) return null
    return normalized
  } catch (error) {
    console.warn('LLM refine failed:', error.message)
    return null
  }
}
