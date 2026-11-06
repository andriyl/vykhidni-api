export const FIELD_CANDIDATES = {
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
  link: ['[itemprop="url"]', 'a[href]'],
  price: ['[itemprop="price"]', '[class*="price"]']
}

const MAX_DESCRIPTION = 5000

export const EXTRACTED_FIELDS = [
  'title',
  'date',
  'time',
  'location',
  'description',
  'image',
  'price'
]

// Used to pull a date out of noisy strings like
// "Презентація аудіоантології 29/10/2025".
const DATE_IN_TEXT_RE =
  /(\d{4}[-./]\d{1,2}[-./]\d{1,2})|(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})|(\d{1,2}\s+(?:січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)(?:\s+\d{4})?)|(\d{1,2}[./-]\d{1,2})/i

export function cleanDate (value) {
  if (!value) return ''
  const match = String(value).match(DATE_IN_TEXT_RE)
  return match ? match[0].replace(/\s+/g, ' ').trim() : String(value).trim()
}

export function cleanTime (value) {
  if (!value) return ''
  const text = String(value).trim()
  // "19:00 - 21:00" stays readable, a date copied into the time field does not.
  if (/^\d{1,2}:\d{2}/.test(text)) return text
  const match = text.match(/(?:^|[T\s])(\d{1,2}:\d{2})(?::\d{2})?/)
  return match ? match[1] : ''
}

export function normalizeActions (actions) {
  if (!Array.isArray(actions)) return []
  const isNewFormat = actions.some(
    (action) => action && action.type === 'extractListItems'
  )

  return actions.map((action) => {
    if (!action || action.type !== 'extractDetails') return action
    // New recipes keep selector chains inside `fields`; legacy recipes keep
    // them flat on the action (or in a flat nested object).
    if (isNewFormat) return action
    const { fields, ...rest } = action
    return { ...rest, ...(fields || {}) }
  })
}

/**
 * Знайти дію певного типу в масиві дій.
 *
 * @param {Array<Object>} actions - Масив дій конфігу
 * @param {string} type - Тип дії (paginate, extractListItems, extractDetails тощо)
 * @returns {Object|undefined} Знайдена дія або undefined
 */
export function getAction (actions, type) {
  return actions.find((a) => a && a.type === type)
}

/**
 * Привести значення до масиву селекторів-ланцюжків.
 * Якщо передано рядок — перетворює на [рядок], якщо масив — фільтрує порожні.
 *
 * @param {string|string[]|null|undefined} value - Селектор або масив селекторів
 * @returns {string[]} Масив непорожніх селекторів
 */
export function toChain (value) {
  if (!value) return []
  return Array.isArray(value) ? value.filter(Boolean) : [value]
}

/**
 * Розбити рядок дати/часу на окремі частини.
 * Підтримує ISO-формати (2026-12-21T18:00), лише дату або лише час.
 *
 * @param {string} raw - Вхідний рядок
 * @returns {{date: string, time: string}|null} Об'єкт з датою та часом або null
 */
export function splitDateTime (raw) {
  if (!raw || typeof raw !== 'string') return null
  const value = raw.trim()

  let match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/
  )
  if (match) {
    return {
      date: `${match[1]}-${match[2]}-${match[3]}`,
      time: `${match[4].padStart(2, '0')}:${match[5]}`
    }
  }

  match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (match) {
    return { date: `${match[1]}-${match[2]}-${match[3]}`, time: '' }
  }

  match = value.match(/^(\d{1,2}):(\d{2})/)
  if (match) {
    return { date: '', time: `${match[1].padStart(2, '0')}:${match[2]}` }
  }

  return null
}

/**
 * Нормалізувати URL відносно базового.
 * Видаляє hash, прибирає UTM-параметри, fbclid, gclid.
 *
 * @param {string} value - Вхідний URL (може бути відносним)
 * @param {string} base - Базовий URL для резолву
 * @returns {string} Нормалізований абсолютний URL
 */
export function normalizeUrl (value, base) {
  if (!value || typeof value !== 'string') return ''
  try {
    const url = new URL(value.trim(), base)
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^fbclid$|^gclid$/i.test(key)) url.searchParams.delete(key)
    }
    return url.toString()
  } catch {
    return value.trim()
  }
}

/**
 * Нормалізувати сирий об'єкт події до єдиного формату.
 * Очищає пробіли, витягає дату/час, нормалізує URL.
 *
 * @param {Object} raw - Сирі дані з extractItems/extractDetail
 * @param {string} pageUrl - URL сторінки для резолву відносних посилань
 * @returns {Object} Нормалізована подія
 */
export function normalizeEvent (raw, pageUrl) {
  const out = {}
  for (const key of EXTRACTED_FIELDS) {
    const value = raw?.[key]
    out[key] =
      typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  }

  out.url = normalizeUrl(raw?.url, pageUrl)
  out.image = out.image ? normalizeUrl(out.image, pageUrl) : ''

  const fromDate = splitDateTime(out.date)
  if (fromDate) {
    out.date = fromDate.date
    if (!out.time && fromDate.time) out.time = fromDate.time
  } else {
    out.date = cleanDate(out.date)
  }

  const fromTime = splitDateTime(out.time)
  if (fromTime?.time) out.time = fromTime.time

  // "19:00" and "19:00 - 21:00" are fine, a date in the time field is not.
  out.time = cleanTime(out.time)

  return out
}

export function fillMissing (target, source) {
  const out = { ...target }
  for (const key of EXTRACTED_FIELDS) {
    if (!out[key] && source?.[key]) out[key] = source[key]
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
export async function extractItems (page, recipe = {}) {
  const item = recipe.item || recipe.selector
  if (!item) return []

  const linkChain = toChain(recipe.link).length
    ? toChain(recipe.link)
    : FIELD_CANDIDATES.link
  const fields = recipe.fields || {}
  const source = recipe.source || 'fields'

  const rows = await page.evaluate(
    ({ item, linkChain, fields, source }) => {
      const clean = (value) =>
        value ? String(value).replace(/\s+/g, ' ').trim() : ''

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
        const match = style.match(/background-image\s*:\s*url\(["']?([^"')]+)/i)
        return match ? abs(match[1]) : ''
      }

      const readValue = (el, field) => {
        if (!el) return ''

        if (field === 'image') {
          if (el.tagName === 'META') return clean(el.getAttribute('content'))
          const img =
            el.tagName === 'IMG' ? el : el.querySelector?.('img')
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
          clean(el.textContent)
        )
      }

      const pick = (root, chain, field) => {
        const selectors = Array.isArray(chain) ? chain : [chain]
        for (const selector of selectors) {
          if (!selector) continue
          let nodes
          try {
            nodes = [...root.querySelectorAll(selector)]
          } catch {
            continue
          }
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
        const location = read('location') || read('address')
        return {
          title: read('name'),
          date: read('startDate'),
          location,
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
        const base = source === 'microdata' ? microdata(root) : {}
        const row = { ...base }

        for (const [field, chain] of Object.entries(fields)) {
          if (!row[field]) row[field] = pick(root, chain, field)
        }

        // Text-level fallbacks: dates and times very often live in an
        // anonymous <span> with no meaningful class.
        if (!row.title) {
          row.title = pick(
            root,
            ['[itemprop="name"]', 'h1', 'h2', 'h3', 'h4', 'a[href]'],
            'title'
          )
        }
        if (!row.image) {
          row.image = pick(root, ['img', '[data-bg]'], 'image')
        }
        if (!row.location) {
          row.location = pick(
            root,
            [
              '[itemprop="location"]',
              '[itemprop="address"]',
              'address',
              '[class*="location"]',
              '[class*="address"]'
            ],
            'location'
          )
        }

        const text = clean(root.textContent)
        if (!row.date) {
          const match = text.match(
            /(\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)|(\d{1,2}\s+(?:січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)(?:\s+\d{4})?)/i
          )
          if (match) row.date = match[0]
        }
        if (!row.time) {
          const match = text.match(/\b(\d{1,2}:\d{2})\b/)
          if (match) row.time = match[1]
        }

        if (!row.url) row.url = pick(root, linkChain, 'link')
        if (!row.url) {
          const propUrl = root.querySelector('[itemprop="url"]')
          if (propUrl) {
            row.url =
              propUrl.getAttribute('content') || propUrl.getAttribute('href') || ''
          }
        }
        if (!row.url) {
          const anchor = root.querySelector('a[href]')
          if (anchor) row.url = abs(anchor.getAttribute('href'))
        }

        return row
      })
    },
    { item, linkChain, fields, source }
  )

  return rows
    .map((row) => normalizeEvent(row, page.url()))
    .filter((row) => row.url)
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
      if (types.some((t) => String(t).includes(wanted))) return value
      for (const child of Object.values(value)) {
        if (child && typeof child === 'object') {
          const found = findType(child, wanted)
          if (found) return found
        }
      }
      return null
    }

    const collect = (value, out = []) => {
      const event = findType(value, 'Event')
      if (event) out.push(event)
      return out
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
        const events = collect(data)
        if (!events.length) continue
        const event = events[0]
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
      } catch {
        // ignore malformed JSON-LD blocks
      }
    }
    return null
  })
}

/**
 * Read schema.org Event microdata from the page. Returns null when absent.
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
 * Generic, structure-agnostic fallbacks. Used on detail pages when no
 * structured data is available.
 */
export async function extractGeneric (page) {
  return page.evaluate(() => {
    const clean = (value) =>
      value ? String(value).replace(/\s+/g, ' ').trim() : ''

    const meta = (name) => {
      const el = document.querySelector(
        `meta[property="${name}"],meta[name="${name}"]`
      )
      return el ? clean(el.getAttribute('content')) : ''
    }

    const pick = (selectors) => {
      for (const selector of selectors) {
        let el
        try {
          el = document.querySelector(selector)
        } catch {
          continue
        }
        if (!el) continue
        const value =
          clean(el.getAttribute('content')) ||
          clean(el.getAttribute('datetime')) ||
          clean(el.textContent)
        if (value) return value
      }
      return ''
    }

    const dateRe =
      /(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})|(\d{1,2}[./-]\d{1,2})|(\d{1,2}\s+(?:січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня)\s*\d{0,4})/i

    const dateText =
      pick(['[itemprop="startDate"]', '[class*="date"]', 'time[datetime]', 'time']) ||
      (document.querySelector('h1')?.textContent || '').match(dateRe)?.[0] ||
      document.body.innerText.match(dateRe)?.[0] ||
      ''

    const timeText =
      pick([
        '[itemprop="startDate"]',
        'time[datetime]',
        'time',
        '[class*="time"]'
      ]) ||
      document.body.innerText.match(/\b\d{1,2}:\d{2}\b/)?.[0] ||
      ''

    const image =
      pick(['[itemprop="image"]', 'meta[property="og:image"]', 'article img', 'main img', 'img']) ||
      meta('og:image')

    return {
      title:
        pick(['h1']) ||
        meta('og:title') ||
        clean(document.title),
      date: dateText,
      time: timeText,
      location: pick([
        '[itemprop="location"]',
        '[itemprop="address"]',
        '[class*="location"]',
        '[class*="address"]',
        'address'
      ]),
      description:
        pick([
          '[itemprop="description"]',
          'meta[property="og:description"]',
          '[itemprop="articleBody"]',
          'article',
          'main'
        ]) || meta('og:description'),
      image,
      url: location.href
    }
  })
}

/**
 * Витягнути подію зі сторінки деталей.
 * Спочатку застосовує задані ланцюжки селекторів, потім доповнює структурованими
 * даними (JSON-LD/microdata), зрештою — загальними евристиками.
 */
export async function extractDetail (page, recipe = {}) {
  const fields = recipe.fields || {}
  let event = {}

  if (Object.keys(fields).length) {
    event = await extractWithChains(page, fields)
  }

  // Microdata має пріоритет, але JSON-LD може доповнити поля, яких у ній немає.
  const microdata = await extractMicrodata(page)
  if (microdata) event = overrideWith(event, microdata)

  const jsonLd = await extractJsonLd(page)
  if (jsonLd) event = fillMissing(event, jsonLd)

  if (recipe.source === 'auto' || !recipe.source) {
    const generic = await extractGeneric(page)
    event = fillMissing(event, generic)
  }

  // Опис із загального тексту сторінки використовуємо лише тоді, коли
  // структуровані дані та селектори не дали нічого. Інакше він затирає
  // чистий опис шумом (меню, футер, сусідні блоки).
  const extra = await page.evaluate(() => {
    const clean = (v) => (v ? String(v).replace(/\s+/g, ' ').trim() : '')
    const meta = (name) => {
      const el = document.querySelector(`meta[property="${name}"],meta[name="${name}"]`)
      return el ? clean(el.getAttribute('content')) : ''
    }
    // Видалити навігацію/футер/скрипти для чистішого тексту
    const clone = document.body.cloneNode(true)
    clone.querySelectorAll('nav,header,footer,script,style,noscript,iframe,.nav,.menu,.header,.footer,.breadcrumbs,.sidebar,.widget,.social,.share,#header,#footer').forEach(el => { try { el.remove() } catch {} })
    const blocks = [
      '[itemprop="articleBody"]',
      '[class*="article-body"]',
      '[class*="event-content"]',
      '[class*="event-text"]',
      '.event-description',
      '.post-content',
      '.content',
      'article',
      'main'
    ]
    let best = ''
    for (const s of blocks) {
      try {
        const el = clone.querySelector(s) || document.querySelector(s)
        if (!el) continue
        const t = clean(el.textContent)
        if (t && t.length > best.length) best = t
      } catch {}
    }
    if (best.length < 150) {
      const t = clean(clone.textContent)
      if (t.length > best.length) best = t
    }
    if (best.length > 80) return best
    return meta('og:description') || meta('description')
  })
  if (!event.description && extra) {
    event.description = extra.slice(0, MAX_DESCRIPTION)
  }
  if (event.description && event.description.length > MAX_DESCRIPTION) {
    event.description = event.description.slice(0, MAX_DESCRIPTION)
  }

  const normalized = normalizeEvent(event, page.url())
  if (!normalized.url) normalized.url = normalizeUrl(page.url())
  return normalized
}

async function extractWithChains (page, fields) {
  const rows = await page.evaluate((fields) => {
    const clean = (value) =>
      value ? String(value).replace(/\s+/g, ' ').trim() : ''

    const readValue = (el, field) => {
      if (!el) return ''
      if (field === 'image') {
        if (el.tagName === 'META') return clean(el.getAttribute('content'))
        const img = el.tagName === 'IMG' ? el : el.querySelector('img')
        if (img) {
          return (
            clean(img.currentSrc) ||
            clean(img.getAttribute('src')) ||
            clean(img.getAttribute('data-src')) ||
            clean(img.getAttribute('data-bg'))
          )
        }
        const style = el.getAttribute('style') || ''
        const match = style.match(/background-image\s*:\s*url\(["']?([^"')]+)/i)
        return match ? clean(match[1]) : clean(el.getAttribute('content'))
      }
      return (
        clean(el.getAttribute('content')) ||
        clean(el.getAttribute('datetime')) ||
        clean(el.getAttribute('value')) ||
        clean(el.textContent)
      )
    }

    const pick = (chain, field) => {
      const selectors = Array.isArray(chain) ? chain : [chain]
      for (const selector of selectors) {
        if (!selector) continue
        let nodes
        try {
          nodes = [...document.querySelectorAll(selector)]
        } catch {
          continue
        }
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
        return values[0]
      }
      return ''
    }

    const out = {}
    for (const [field, chain] of Object.entries(fields)) {
      out[field] = pick(chain, field)
    }
    return out
  }, fields)

  return rows || {}
}

/**
 * Quick structured-data fingerprint, used by discovery.
 */
export async function detectStructured (page) {
  return page.evaluate(() => {
    const clean = (value) =>
      value ? String(value).replace(/\s+/g, ' ').trim() : ''

    const types = []
    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]'
    )) {
      try {
        const walk = (value) => {
          if (Array.isArray(value)) return value.forEach(walk)
          if (value && typeof value === 'object') {
            if (value['@type']) {
              const list = Array.isArray(value['@type'])
                ? value['@type']
                : [value['@type']]
              list.forEach((type) => types.push(String(type)))
            }
            Object.values(value).forEach((child) => {
              if (child && typeof child === 'object') walk(child)
            })
          }
        }
        walk(JSON.parse(script.textContent))
      } catch {
        // ignore malformed blocks
      }
    }

    const meta = (name) => {
      const el = document.querySelector(
        `meta[property="${name}"],meta[name="${name}"]`
      )
      return el ? clean(el.getAttribute('content')) : ''
    }

    return {
      jsonLdTypes: [...new Set(types)],
      hasEventJsonLd: types.some((type) => type.includes('Event')),
      microdataEvents: document.querySelectorAll(
        '[itemtype*="schema.org/Event"]'
      ).length,
      microdataProps: [
        ...new Set(
          [...document.querySelectorAll('[itemprop]')].map((el) =>
            el.getAttribute('itemprop')
          )
        )
      ],
      ogTitle: meta('og:title'),
      ogImage: meta('og:image'),
      ogDescription: meta('og:description'),
      h1: clean(document.querySelector('h1')?.textContent),
      timeDatetime: clean(
        document.querySelector('time[datetime]')?.getAttribute('datetime')
      )
    }
  })
}
