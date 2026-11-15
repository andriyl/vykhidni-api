import { MAX_DESCRIPTION, validateEvent } from '../utils.js'

export const EXTRACTED_FIELDS = [
  'title',
  'date',
  'time',
  'location',
  'description',
  'image',
  'price'
]

const FALLBACK_FIELDS = {
  title: [
    '[itemprop="name"]',
    'h1',
    'h2',
    'h3',
    'h4',
    '[class*="title"]',
    '[class*="name"]',
    'a[href]'
  ],
  date: [
    '[itemprop="startDate"]',
    '[itemprop="date"]',
    'time[datetime]',
    'time',
    '[class*="date"]'
  ],
  time: [
    '[itemprop="startDate"]',
    'time[datetime]',
    '[class*="time"]',
    '[class*="date"]'
  ],
  image: [
    '[itemprop="image"]',
    'img',
    '[data-bg]',
    '[style*="background-image"]'
  ],
  location: [
    '[itemprop="location"]',
    '[itemprop="address"]',
    '[class*="location"]',
    '[class*="address"]',
    'address'
  ],
  description: [
    '[itemprop="description"]',
    '[class*="description"]',
    '[class*="desc"]',
    'article p',
    'p'
  ],
  price: ['[itemprop="price"]', '[class*="price"]']
}

const GENERIC_DETAIL_FIELDS = {
  title: ['h1', 'meta[property="og:title"]'],
  date: [
    '[itemprop="startDate"]',
    'time[datetime]',
    'time',
    '[class*="date"]'
  ],
  time: ['[itemprop="startDate"]', 'time[datetime]', 'time'],
  location: [
    '[itemprop="location"]',
    '[itemprop="address"]',
    'address',
    '[class*="location"]',
    '[class*="address"]'
  ],
  description: [
    '[itemprop="description"]',
    'meta[property="og:description"]',
    '[class*="event-content"]',
    '[class*="event-description"]',
    '[class*="description"]',
    '[class*="desc"]',
    'article p'
  ],
  image: [
    '[itemprop="image"]',
    'meta[property="og:image"]',
    'article img',
    'main img',
    'img'
  ],
  price: ['[itemprop="price"]', '[class*="price"]']
}

/**
 * Only the current (array) recipe format is supported. Kept as a small
 * normalizer so all callers receive an array.
 */
export function normalizeActions (actions) {
  if (!Array.isArray(actions)) return []
  return actions.filter((action) => action && typeof action === 'object')
}

/**
 * Знайти дію певного типу в масиві дій.
 *
 * @param {Array<Object>} actions - Масив дій конфігу
 * @param {string} type - Тип дії (paginate, extractListItems, extractDetails тощо)
 * @returns {Object|undefined} Знайдена дія або undefined
 */
export function getAction (actions, type) {
  return actions.find((action) => action && action.type === type)
}

/**
 * Привести значення до масиву селекторів-ланцюжків.
 *
 * @param {string|string[]|null|undefined} value - Селектор або масив селекторів
 * @returns {string[]} Масив непорожніх селекторів
 */
export function toChain (value) {
  if (!value) return []
  if (Array.isArray(value)) return value.filter(Boolean)
  return [value]
}

/**
 * Нормалізувати URL відносно базового (абсолютізація; hash/UTM не чіпаємо).
 */
export function normalizeUrl (value, base) {
  if (!value || typeof value !== 'string') return ''
  try {
    return new URL(value.trim(), base).toString()
  } catch {
    return value.trim()
  }
}

/**
 * Нормалізувати сирий об'єкт події до єдиного формату.
 * Очищає пробіли, витягає дату/час, нормалізує URL.
 */
export function normalizeEvent (raw, pageUrl) {
  const out = {}
  for (const key of EXTRACTED_FIELDS) {
    const value = raw?.[key]
    out[key] = typeof value === 'string' ? value : ''
  }

  // Many sites put a full ISO datetime or a date range into the time field;
  // keep HH:mm and drop anything that is not a clock time (time is optional).
  const iso = out.time.match(/T(\d{1,2}):(\d{2})/)
  const plain = out.time.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?$/)
  if (iso) out.time = `${iso[1].padStart(2, '0')}:${iso[2]}`
  else if (plain) out.time = `${plain[1].padStart(2, '0')}:${plain[2]}`
  else out.time = ''

  out.url = normalizeUrl(raw?.url, pageUrl)
  out.image = out.image ? normalizeUrl(out.image, pageUrl) : ''

  // A page may use the date as its only <h1>; that is not a title.
  if (!/[a-zа-яіїєґ]/i.test(out.title)) out.title = ''

  // A hidden element can carry escaped page markup; never keep that as text.
  if (/<(?:script|iframe|div|html|body|head|p|span|img)\b/i.test(out.description)) {
    out.description = ''
  }

  return out
}

export function overrideWith (target, source) {
  const out = { ...target }
  for (const key of EXTRACTED_FIELDS) {
    if (source?.[key]) out[key] = source[key]
  }
  return out
}

/**
 * Витягнути список подій з лістингу.
 * Повертає нормалізовані події з полями title/date/time/location/description/image/url.
 */
export async function extractItems (
  page,
  recipe = {},
  { validate = true, allowDocument = false } = {}
) {
  const item = recipe.item || recipe.selector
  if (!item) return []

  const linkChain = toChain(recipe.link).length
    ? toChain(recipe.link)
    : ['[itemprop="url"]', 'a[href]']
  const fields = recipe.fields || {}
  const source = recipe.source || 'fields'
  const requireUrl = recipe.requireUrl !== false
  const fallbacks = recipe.fallbacks || FALLBACK_FIELDS
  // Detail extraction is not validated, so only listing rows get a length cap.
  const descriptionMax = validate ? MAX_DESCRIPTION : 0

  const rows = await page.evaluate(
    ({ item, linkChain, fields, fallbacks, descriptionMax, source, allowDocument }) => {
      const clean = (value) =>
        value ? String(value).replace(/\s+/g, ' ').trim() : ''

      // <meta>/<link> live in <head>; a detail page is rooted at <body>.
      const queryAll = (root, selector) => {
        try {
          const nodes = root.querySelectorAll(selector)
          if (nodes.length || root === document || !allowDocument) return nodes
          if (!/^(meta|link)\b/.test(selector)) return nodes
          return document.querySelectorAll(selector)
        } catch {
          return []
        }
      }

      const chainOf = (value) => {
        if (!value) return []
        return Array.isArray(value) ? value.filter(Boolean) : [value]
      }

      const abs = (href) => {
        if (!href) return ''
        try {
          const url = new URL(href, location.href)
          url.hash = ''
          return url.toString()
        } catch {
          return href
        }
      }

      const bg = (el) => {
        const style = el.getAttribute?.('style') || ''
        const match = style.match(
          /background-image\s*:\s*url\(["']?([^"')]+)/i
        )
        return match ? abs(match[1]) : ''
      }

      const readValue = (el, field) => {
        if (!el) return ''

        if (field === 'image') {
          if (el.tagName === 'META') return clean(el.getAttribute('content'))
          const img = el.tagName === 'IMG' ? el : el.querySelector?.('img')
          if (img) {
            return (
              clean(img.currentSrc) ||
              clean(img.getAttribute('src')) ||
              clean(img.getAttribute('data-src')) ||
              clean(img.getAttribute('data-bg')) ||
              bg(img)
            )
          }
          return (
            clean(el.getAttribute('content')) ||
            clean(el.getAttribute('data-src')) ||
            clean(el.getAttribute('data-bg')) ||
            bg(el)
          )
        }

        if (field === 'link' || field === 'url') {
          const anchor =
            el.tagName === 'A' ? el : el.querySelector?.('a[href]')
          const href =
            (anchor && anchor.getAttribute('href')) ||
            el.getAttribute('content') ||
            el.getAttribute('href')
          return href ? abs(href) : ''
        }

        return (
          clean(el.getAttribute('content')) ||
          clean(el.getAttribute('datetime')) ||
          clean(el.getAttribute('value')) ||
          clean(el.innerText || el.textContent)
        )
      }

      const pick = (root, chain, field) => {
        for (const selector of chainOf(chain)) {
          if (!selector) continue
          const nodes = [...queryAll(root, selector)]
          const values = nodes
            .map((node) => readValue(node, field))
            .filter((value) => value && value.length > 1)
          if (!values.length) continue

          if (field === 'title') {
            const plausible = values
              .filter((value) => value.length >= 3 && value.length <= 300)
              .sort((a, b) => b.length - a.length)
            if (plausible.length) return plausible[0]
          }

          if (field === 'image') {
            const image = values.find((value) => /^(https?:|data:|\/)/.test(value))
            if (image) return image
            continue
          }

          return values[0]
        }
        return ''
      }

      // Опис збираємо з УСІХ селекторів рецепта: LLM підбирає кілька блоків
      // (текст, деталі, ціна, вік), які разом дають логічний опис події.
      const collect = (root, chain, field, max) => {
        const values = []
        for (const selector of chainOf(chain)) {
          if (!selector) continue
          for (const node of queryAll(root, selector)) {
            const value = readValue(node, field)
            if (value && value.length > 1) values.push(value)
          }
        }
        const unique = [...new Set(values)]
        // If one selected block contains another, they are the same text twice:
        // keep the child when it is most of the wrapper (the wrapper adds page
        // chrome), keep the wrapper when the child is only a small fragment.
        const dropped = new Set()
        for (const value of unique) {
          for (const other of unique) {
            if (
              other === value ||
              other.length <= value.length ||
              !other.includes(value)
            ) {
              continue
            }
            dropped.add(value.length >= other.length * 0.5 ? other : value)
          }
        }
        const kept = unique.filter((value) => !dropped.has(value))
        const joined = kept.join('\n\n')
        // Listing rows are validated against MAX_DESCRIPTION: a joined blob that
        // long would drop the whole event, so keep the first block instead.
        if (max && joined.length > max) return kept[0] || ''
        return joined
      }

      const microdata = (root) => {
        const read = (prop) => {
          const el = root.querySelector(`[itemprop="${prop}"]`)
          if (!el) return ''
          const value =
            clean(el.getAttribute('content')) ||
            clean(el.getAttribute('datetime'))
          if (prop === 'url') {
            return value || clean(el.getAttribute('href')) || clean(el.textContent)
          }
          return value || clean(el.textContent)
        }
        return {
          title: read('name'),
          date: read('startDate'),
          location: read('location') || read('address'),
          description: read('description'),
          image: read('image'),
          url: read('url'),
          price: read('price')
        }
      }

      let roots = []
      try {
        roots = [...document.querySelectorAll(item)]
      } catch {
        return []
      }

      return roots.map((root) => {
        const row = source === 'microdata' ? microdata(root) : {}

        // Recipe selectors first, then generic fallbacks for still-empty fields.
        for (const [field, chain] of Object.entries(fallbacks)) {
          if (row[field]) continue
          let value = field === 'description'
            ? collect(root, fields[field], field, descriptionMax)
            : ''
          if (!value) {
            value = pick(root, [...chainOf(fields[field]), ...chain], field)
          }
          if (value) row[field] = value
        }

        if (!row.url) row.url = pick(root, linkChain, 'link')
        if (!row.url) {
          const propUrl = root.querySelector('[itemprop="url"]')
          if (propUrl) {
            row.url =
              propUrl.getAttribute('content') ||
              propUrl.getAttribute('href') ||
              ''
          }
        }
        if (!row.url) {
          const anchor = root.querySelector('a[href]')
          if (anchor) row.url = abs(anchor.getAttribute('href'))
        }

        return row
      })
    },
    { item, linkChain, fields, fallbacks, descriptionMax, source, allowDocument }
  )

  return rows
    .map((row) => normalizeEvent(row, page.url()))
    .filter((row) => !requireUrl || row.url)
    .filter((row) => validate ? validateEvent(row).valid : true)
}

/**
 * Read schema.org/Event JSON-LD from the page. Returns null when absent.
 */
export async function extractJsonLd (page) {
  return page.evaluate(() => {
    const clean = (value) =>
      value ? String(value).replace(/\s+/g, ' ').trim() : ''

    const findType = (value, wanted) => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          const found = findType(entry, wanted)
          if (found) return found
        }
        return null
      }
      if (!value || typeof value !== 'object') return null
      const type = value['@type']
      const types = Array.isArray(type) ? type : [type]
      if (types.some((entry) => String(entry).includes(wanted))) return value
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
          const found = findType(child, wanted)
          if (found) return found
        }
      }
      return null
    }

    const locationOf = (raw) => {
      if (!raw) return ''
      const list = Array.isArray(raw) ? raw : [raw]
      const parts = []
      for (const entry of list) {
        if (typeof entry === 'string') {
          parts.push(entry)
          continue
        }
        if (entry.name) parts.push(entry.name)
        const address = entry.address
        if (typeof address === 'string') parts.push(address)
        else if (address) {
          parts.push(
            [address.streetAddress, address.addressLocality]
              .filter(Boolean)
              .join(', ')
          )
        }
      }
      return clean(parts.filter(Boolean).join(', '))
    }

    const imageOf = (raw) => {
      if (!raw) return ''
      const list = Array.isArray(raw) ? raw : [raw]
      for (const entry of list) {
        if (typeof entry === 'string') return clean(entry)
        if (entry?.url) return clean(entry.url)
        if (entry?.contentUrl) return clean(entry.contentUrl)
      }
      return ''
    }

    const priceOf = (raw) => {
      if (!raw) return ''
      const offers = Array.isArray(raw) ? raw[0] : raw
      return clean(offers?.price || offers?.lowPrice)
    }

    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]'
    )) {
      try {
        const data = JSON.parse(script.textContent)
        const event = findType(data, 'Event')
        if (!event) continue
        return {
          title: clean(event.name),
          date: clean(event.startDate),
          time: clean(event.startDate),
          location: locationOf(event.location),
          description: clean(event.description),
          image: imageOf(event.image),
          url: clean(event.url || event.mainEntityOfPage),
          price: priceOf(event.offers)
        }
      } catch {}
    }
    return null
  })
}

/**
 * Read schema.org/Event microdata from the page. Returns null when absent.
 */
export async function extractMicrodata (page) {
  return page.evaluate(() => {
    const clean = (value) =>
      value ? String(value).replace(/\s+/g, ' ').trim() : ''

    const root =
      document.querySelector('[itemtype*="schema.org/Event"]') ||
      document.querySelector('[itemprop="event"]')
    if (!root) return null

    const read = (prop) => {
      const el = root.querySelector(`[itemprop="${prop}"]`)
      if (!el) return ''
      const value =
        clean(el.getAttribute('content')) ||
        clean(el.getAttribute('datetime'))
      if (prop === 'url') {
        return value || clean(el.getAttribute('href')) || clean(el.textContent)
      }
      return value || clean(el.textContent)
    }

    return {
      title: read('name'),
      date: read('startDate'),
      time: read('startDate'),
      location: read('location') || read('address'),
      description: read('description'),
      image: read('image'),
      url: read('url'),
      price: read('price')
    }
  })
}

/**
 * Does a structured-data title describe the page's own event? Related-event
 * blocks repeat elsewhere on the page, so a low word overlap means "not ours".
 */
export function sameEventTitle (title, heading) {
  const words = (value) =>
    String(value || '')
      .toLowerCase()
      .match(/[a-zа-яіїєґ0-9]{3,}/g) || []
  const own = words(title)
  if (!own.length) return true
  const page = new Set(words(heading))
  if (!page.size) return true
  const hits = own.filter((word) => page.has(word)).length
  return hits / own.length >= 0.6
}

/**
 * Витягнути подію зі сторінки деталей. Generic-поля з усього body, потім
 * structured data (JSON-LD/microdata) перекриває їх.
 */
export async function extractDetail (page, recipe = {}, { withMeta = false } = {}) {
  const [generic] = await extractItems(
    page,
    {
      item: 'body',
      fields: recipe.fields || {},
      fallbacks: GENERIC_DETAIL_FIELDS,
      source: recipe.source || 'fields',
      requireUrl: false
    },
    { validate: false, allowDocument: true }
  )

  let event = generic || {}
  const jsonLd = await extractJsonLd(page)
  const microdata = jsonLd ? null : await extractMicrodata(page)
  let structured = jsonLd || microdata

  // Related-event widgets carry their own JSON-LD/microdata; only trust the
  // structured block when its title is the page's own event.
  if (structured?.title) {
    const heading = await page.evaluate(() => {
      const clean = (v) => (v ? String(v).replace(/\s+/g, ' ').trim() : '')
      const h1 = document.querySelector('h1')
      const og = document.querySelector('meta[property="og:title"]')
      return [clean(h1?.innerText), clean(og?.getAttribute('content')), clean(document.title)]
        .filter(Boolean)
        .join(' | ')
    })
    if (!sameEventTitle(structured.title, heading)) structured = null
  }

  if (structured) event = overrideWith(event, structured)

  const normalized = normalizeEvent(event, page.url())
  normalized.url = normalizeUrl(page.url())

  if (!withMeta) return normalized

  return {
    event: normalized,
    structured: {
      source: jsonLd ? 'jsonLd' : microdata ? 'microdata' : null,
      title: Boolean(structured?.title),
      date: Boolean(structured?.date)
    }
  }
}

/**
 * Keep only selectors that resolve on the page and return a usable value.
 * LLM guesses that match nothing must never reach the saved site config.
 */
export async function workingFields (page, fields = {}) {
  return page.evaluate((fields) => {
    const clean = (value) =>
      value ? String(value).replace(/\s+/g, ' ').trim() : ''
    const markup = /<(?:script|iframe|div|html|body|head|p|span|img)\b/i

    const valueOf = (el, field) => {
      if (field === 'image') {
        const img = el.tagName === 'IMG' ? el : el.querySelector?.('img')
        if (img) {
          return clean(
            img.currentSrc ||
              img.getAttribute('src') ||
              img.getAttribute('data-src')
          )
        }
        return clean(el.getAttribute('content'))
      }
      return (
        clean(el.getAttribute('content')) ||
        clean(el.getAttribute('datetime')) ||
        clean(el.getAttribute('value')) ||
        clean(el.innerText || '')
      )
    }

    const out = {}
    for (const [field, chain] of Object.entries(fields)) {
      const working = []
      for (const selector of Array.isArray(chain) ? chain : [chain]) {
        if (!selector) continue
        let nodes
        try {
          nodes = [...document.querySelectorAll(selector)]
        } catch {
          continue
        }
        const ok = nodes.some((node) => {
          const value = valueOf(node, field)
          return value.length > 1 && !markup.test(value)
        })
        if (ok) working.push(selector)
      }
      if (working.length) out[field] = working
    }
    return out
  }, fields)
}
