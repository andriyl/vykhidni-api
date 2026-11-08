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
  date: ['[itemprop="startDate"]', 'time[datetime]', 'time'],
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
    'article',
    'main'
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

  out.url = normalizeUrl(raw?.url, pageUrl)
  out.image = out.image ? normalizeUrl(out.image, pageUrl) : ''

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
    : ['[itemprop="url"]', 'a[href]']
  const fields = recipe.fields || {}
  const source = recipe.source || 'fields'
  const requireUrl = recipe.requireUrl !== false

  const rows = await page.evaluate(
    ({ item, linkChain, fields, fallbacks, source }) => {
      const clean = (value) =>
        value ? String(value).replace(/\s+/g, ' ').trim() : ''

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
          clean(el.textContent)
        )
      }

      const pick = (root, chain, field) => {
        for (const selector of chainOf(chain)) {
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
          const value = pick(
            root,
            [...chainOf(fields[field]), ...chain],
            field
          )
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
    { item, linkChain, fields, fallbacks: FALLBACK_FIELDS, source }
  )

  return rows
    .map((row) => normalizeEvent(row, page.url()))
    .filter((row) => !requireUrl || row.url)
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
 * Витягнути подію зі сторінки деталей. Generic-поля з усього body, потім
 * structured data (JSON-LD/microdata) перекриває їх.
 */
export async function extractDetail (
  page,
  recipe = {},
  { withMeta = false } = {}
) {
  const fields = { ...GENERIC_DETAIL_FIELDS, ...(recipe.fields || {}) }
  const [generic] = await extractItems(page, {
    item: 'body',
    fields,
    source: recipe.source || 'fields',
    requireUrl: false
  })

  let event = generic || {}
  const jsonLd = await extractJsonLd(page)
  const microdata = jsonLd ? null : await extractMicrodata(page)
  const structured = jsonLd || microdata
  if (structured) event = overrideWith(event, structured)

  const normalized = normalizeEvent(event, page.url())
  normalized.url = normalizeUrl(page.url())

  // Prefer the full visible text of the event page over the short teaser
  // that most sites put in og:description / itemprop="description".
  try {
    const fullText = await page.evaluate(() => {
      const root =
        document.querySelector('main, article, [role="main"]') ||
        document.body
      const clone = root.cloneNode(true)
      clone
        .querySelectorAll('script, style, nav, header, footer, aside, form, button, [role="navigation"]')
        .forEach((node) => node.remove())
      return (clone.innerText || clone.textContent || '').trim()
    })
    if (fullText && fullText.length > 80) {
      if (
        !normalized.description ||
        fullText.length > (normalized.description || '').length
      ) {
        normalized.description = fullText
      }
    }
  } catch {
    // keep the description we already have
  }

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
