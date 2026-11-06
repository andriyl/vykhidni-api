import { FIELD_CANDIDATES } from '../scanner/extract.js'

/**
 * Аналіз лістингу в браузері: пошук повторюваних карток, пагінації, seed-URL,
 * структурованих даних.
 */
export async function analyzeListing (page) {
  return page.evaluate(() => {
    const clean = (value) =>
      value ? String(value).replace(/\s+/g, ' ').trim() : ''

    const DATE_RE =
      /(\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)|(\d{1,2}\s+(?:січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня))/i

    const isDynamicClass = (name) =>
      !name ||
      name.length > 60 ||
      /\d{3,}/.test(name) ||
      /^(odd|even|first|last|active|row|clearfix|show|d-block|grid-sizer)$/i.test(
        name
      ) ||
      /(^|-)(\d+|odd|even|first|last)$/i.test(name)

    const stableClasses = (el) =>
      [...el.classList].filter((name) => !isDynamicClass(name)).slice(0, 3)

    const sig = (el) => {
      const classes = [...el.classList]
        .map((name) =>
          String(name)
            .replace(/\b(odd|even|first|last|active)\b/gi, '')
            .replace(/\d+/g, '#')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '')
        )
        .filter(Boolean)
        .sort()
        .join('.')
      return `${el.tagName}|${classes}|${el.children.length}`
    }

    const isUniqueSelector = (selector, expected) => {
      try {
        const found = document.querySelectorAll(selector).length
        return found >= Math.max(3, expected * 0.7) && found <= expected * 2 + 5
      } catch {
        return false
      }
    }

    const selectorForGroup = (parent, sample, expected) => {
      const tag = sample.tagName.toLowerCase()
      const classes = stableClasses(sample)
      const candidates = []

      if (sample.id) candidates.push(`#${CSS.escape(sample.id)}`)
      if (classes.length) {
        candidates.push(
          `${tag}.${classes.map((name) => CSS.escape(name)).join('.')}`
        )
        candidates.push(
          `${tag}.${CSS.escape(classes[0])}`
        )
      }

      const parentParts = []
      let node = parent
      for (let depth = 0; depth < 4 && node && node !== document.body; depth++) {
        if (node.id) {
          parentParts.unshift(`#${CSS.escape(node.id)}`)
          break
        }
        const parentClasses = stableClasses(node).slice(0, 2)
        parentParts.unshift(
          `${node.tagName.toLowerCase()}${
            parentClasses.length
              ? `.${parentClasses.map((name) => CSS.escape(name)).join('.')}`
              : ''
          }`
        )
        node = node.parentElement
      }

      if (parentParts.length) {
        const parentSelector = parentParts.join('>')
        if (classes.length) {
          candidates.push(
            `${parentSelector}>${tag}.${CSS.escape(classes[0])}`
          )
        }
        candidates.push(`${parentSelector}>${tag}`)
      }

      for (const candidate of candidates) {
        if (isUniqueSelector(candidate, expected)) return candidate
      }
      return null
    }

    const groups = new Map()
    for (const parent of document.querySelectorAll('body *')) {
      const children = [...parent.children]
      if (children.length < 3 || children.length > 120) continue

      const bySignature = new Map()
      for (const child of children) {
        const key = sig(child)
        if (!bySignature.has(key)) bySignature.set(key, [])
        bySignature.get(key).push(child)
      }

      for (const [, elements] of bySignature) {
        if (elements.length < 3) continue
        const count = elements.length
        const linkRatio =
          elements.filter((el) => el.querySelector('a[href]')).length / count
        const imageRatio =
          elements.filter(
            (el) =>
              el.querySelector('img,[data-bg],[style*="background-image"]')
          ).length / count
        const dateRatio =
          elements.filter((el) => DATE_RE.test(el.textContent || '')).length /
          count
        const avgText =
          elements
            .map((el) => clean(el.textContent).length)
            .reduce((sum, value) => sum + value, 0) / count

        // Navigation menus and tag clouds are usually short <a> siblings.
        const looksLikeNav = elements.every(
          (el) =>
            el.tagName === 'A' && clean(el.textContent).length < 25
        )
        const lengthScore =
          avgText > 20 && avgText < 900 ? 1 : avgText >= 900 ? 0.35 : 0.2

        const score =
          Math.round(
            count *
              (0.2 + linkRatio) *
              (1 + imageRatio * 0.8) *
              (1 + dateRatio * 1.6) *
              lengthScore *
              (looksLikeNav ? 0.1 : 1) *
              10
          ) / 10

        const key = sig(elements[0])
        const previous = groups.get(key)
        if (previous && previous.score >= score) continue

        const selector =
          selectorForGroup(parent, elements[0], count) ||
          (elements[0].id ? `#${CSS.escape(elements[0].id)}` : null)
        if (!selector) continue

        groups.set(key, {
          selector,
          count,
          linkRatio: +linkRatio.toFixed(2),
          imageRatio: +imageRatio.toFixed(2),
          dateRatio: +dateRatio.toFixed(2),
          avgText: Math.round(avgText),
          looksLikeNav,
          score
        })
      }
    }

    const candidates = [...groups.values()]
      .filter((group) => group.count >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)

    const pagination = { mode: 'none', maxPages: 5, seedUrls: [] }
    const anchors = [...document.querySelectorAll('a[href]')]

    const nextAnchor = anchors.find(
      (el) =>
        el.getAttribute('rel') === 'next' ||
        /^(наступна|наступний|далі|next)$/i.test(clean(el.textContent))
    )
    const pageAnchors = anchors.filter((el) =>
      /[?&]page=\d+/i.test(el.getAttribute('href') || '')
    )

    if (nextAnchor) {
      const selector = nextAnchor.id
        ? `#${CSS.escape(nextAnchor.id)}`
        : nextAnchor.getAttribute('rel') === 'next'
          ? 'a[rel="next"]'
          : null
      pagination.mode = 'url'
      if (selector) pagination.selector = selector
    } else if (pageAnchors.length) {
      pagination.mode = 'url'
      pagination.param = 'page'
      const selector = selectorForGroup(
        pageAnchors[0].parentElement,
        pageAnchors[0],
        pageAnchors.length
      )
      if (selector) pagination.selector = selector
    }

    const loadMore = [...document.querySelectorAll('button,a')].find((el) => {
      const text = clean(el.textContent)
      return (
        el.offsetParent !== null &&
        text.length < 40 &&
        /показати ще|завантажити ще|більше подій|show more|load more|more events/i.test(
          text
        )
      )
    })

    if (!nextAnchor && !pageAnchors.length && loadMore) {
      const classes = stableClasses(loadMore)
      pagination.mode = 'loadMore'
      pagination.selector =
        loadMore.id
          ? `#${CSS.escape(loadMore.id)}`
          : classes.length
            ? `${loadMore.tagName.toLowerCase()}.${classes
              .map((name) => CSS.escape(name))
              .join('.')}`
            : null
      pagination.text = clean(loadMore.textContent)
    }

    // Date-bucket navigation (e.g. /search/NextWeek/) is not pagination,
    // but it is useful as extra seed URLs.
    const seedUrls = [
      ...new Set(
        anchors
          .map((el) => el.getAttribute('href'))
          .filter(
            (href) =>
              href &&
              /\/(search|events?|afisha|podii|calendar)\/(today|tomorrow|thisweek|nextweek|weekend)/i.test(
                href
              )
          )
          .map((href) => {
            try {
              return new URL(href, location.href).toString()
            } catch {
              return href
            }
          })
      )
    ].slice(0, 6)

    const ldTypes = []
    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]'
    )) {
      try {
        const walk = (value) => {
          if (Array.isArray(value)) return value.forEach(walk)
          if (value && typeof value === 'object') {
            if (value['@type']) {
              const types = Array.isArray(value['@type'])
                ? value['@type']
                : [value['@type']]
              types.forEach((type) => ldTypes.push(String(type)))
            }
            Object.values(value).forEach((child) => {
              if (child && typeof child === 'object') walk(child)
            })
          }
        }
        walk(JSON.parse(script.textContent))
      } catch {
        // ignore
      }
    }

    const bodyText = clean(document.body.innerText)

    return {
      title: document.title,
      url: location.href,
      candidates,
      pagination: { ...pagination, seedUrls },
      structured: {
        jsonLdTypes: [...new Set(ldTypes)],
        hasEventJsonLd: ldTypes.some((type) => type.includes('Event')),
        microdataEvents: document.querySelectorAll(
          '[itemtype*="schema.org/Event"]'
        ).length,
        microdataProps: [
          ...new Set(
            [...document.querySelectorAll('[itemprop]')].map((el) =>
              el.getAttribute('itemprop')
            )
          )
        ]
      },
      navHints: [
        ...new Set(
          anchors
            .map((el) => el.getAttribute('href'))
            .filter(
              (href) =>
                href &&
                /event|afish|podii|calendar|children|заход|поді|діт/i.test(href)
            )
        )
      ].slice(0, 10),
      bodyLength: bodyText.length
    }
  })
}

/**
 * Test every known field candidate against sample items and return the
 * chains that actually produce values.
 */
export async function detectFields (
  page,
  itemSelector,
  { limit = 6, candidates = FIELD_CANDIDATES } = {}
) {
  return page.evaluate(
    ({ itemSelector, limit, candidates }) => {
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
          const match = style.match(
            /background-image\s*:\s*url\(["']?([^"')]+)/i
          )
          return match ? clean(match[1]) : clean(el.getAttribute('content'))
        }
        if (field === 'link' || field === 'url') {
          const anchor = el.tagName === 'A' ? el : el.querySelector('a[href]')
          return clean(
            (anchor && anchor.getAttribute('href')) ||
              el.getAttribute('content') ||
              el.getAttribute('href')
          )
        }
        return (
          clean(el.getAttribute('content')) ||
          clean(el.getAttribute('datetime')) ||
          clean(el.getAttribute('value')) ||
          clean(el.textContent)
        )
      }

      let roots = []
      try {
        roots = [...document.querySelectorAll(itemSelector)].slice(0, limit)
      } catch {
        return { fields: {}, stats: {} }
      }
      if (!roots.length) return { fields: {}, stats: {} }

      const DATE_RE =
        /(\d{1,2}[./-]\d{1,2})|(\d{1,2}\s+(?:січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня))/i

      const fields = {}
      const stats = {}

      for (const [field, chain] of Object.entries(candidates)) {
        const scored = []

        for (const selector of chain) {
          const values = []
          for (const root of roots) {
            let nodes = []
            try {
              nodes = [...root.querySelectorAll(selector)]
            } catch {
              continue
            }
            const candidatesValues = nodes
              .map((node) => readValue(node, field))
              .filter((value) => value && value.length > 1)

            let value = candidatesValues[0] || ''
            if (field === 'title') {
              value =
                candidatesValues
                  .filter((v) => v.length >= 3 && v.length <= 300)
                  .sort((a, b) => b.length - a.length)[0] || ''
            }
            if (field === 'image') {
              value =
                candidatesValues.find((v) => /^(https?:|data:|\/)/.test(v)) ||
                ''
            }
            values.push(value)
          }

          const filled = values.filter(Boolean).length
          const fillRate = filled / roots.length
          const avgLength =
            values.reduce((sum, value) => sum + value.length, 0) /
            Math.max(1, values.length)

          let plausible = fillRate >= 0.5
          if (field === 'title') plausible = plausible && avgLength >= 3 && avgLength <= 300
          if (field === 'date') {
            plausible = plausible && values.some((value) => DATE_RE.test(value))
          }
          if (field === 'time') {
            plausible =
              plausible &&
              values.some((value) => /\d{1,2}[:.]\d{2}/.test(value))
          }
          if (field === 'image') {
            plausible = plausible && values.some((value) => /^(https?:|data:|\/)/.test(value))
          }
          if (field === 'description') {
            plausible =
              plausible &&
              avgLength >= 40 &&
              !values.every((value) => DATE_RE.test(value) && value.length < 40)
          }
          if (!plausible) continue

          let bonus = 0
          if (field === 'date' || field === 'time') {
            if (values.some((value) => /^\d{4}-\d{2}-\d{2}/.test(value))) {
              bonus += 0.4
            }
            if (values.some((value) => /^\d{1,2}:\d{2}$/.test(value))) {
              bonus += 0.2
            }
            if (avgLength > 30) bonus -= 0.3
          }
          if (field === 'title') {
            if (/itemprop|h[1-4]|title|name/i.test(selector)) bonus += 0.3
            if (avgLength >= 5 && avgLength <= 140) bonus += 0.2
            else if (avgLength > 200) bonus -= 0.5
          }

          scored.push({
            selector,
            fillRate: +fillRate.toFixed(2),
            avgLength: Math.round(avgLength),
            score: +(fillRate + bonus).toFixed(3)
          })
        }

        scored.sort(
          (a, b) =>
            b.score - a.score ||
            a.avgLength - b.avgLength
        )
        if (scored.length) {
          fields[field] = scored.slice(0, 2).map((entry) => entry.selector)
          stats[field] = scored[0]
        }
      }

      return { fields, stats }
    },
    { itemSelector, limit, candidates }
  )
}

/**
 * Same as detectFields, but for a single detail page: evaluates candidates
 * against the whole document.
 */
export async function detectDetailFields (page) {
  return page.evaluate((candidates) => {
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

    const DATE_RE =
      /(\d{1,2}[./-]\d{1,2})|(\d{1,2}\s+(?:січня|лютого|березня|квітня|травня|червня|липня|серпня|вересня|жовтня|листопада|грудня))/i

    const fields = {}
    const stats = {}

    for (const [field, chain] of Object.entries(candidates)) {
      if (field === 'link') continue
      for (const selector of chain) {
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

        let value = values[0]
        if (field === 'title') {
          value =
            values
              .filter((v) => v.length >= 3 && v.length <= 300)
              .sort((a, b) => b.length - a.length)[0] || ''
        }
        if (field === 'image') {
          value = values.find((v) => /^(https?:|data:|\/)/.test(v)) || ''
        }
        if (!value) continue

        const plausible =
          field === 'date'
            ? DATE_RE.test(value)
            : field === 'time'
              ? /\d{1,2}[:.]\d{2}/.test(value)
              : field === 'image'
                ? /^(https?:|data:|\/)/.test(value)
                : field === 'title'
                  ? value.length >= 3 && value.length <= 300
                  : true

        if (!plausible) continue
        fields[field] = [selector]
        stats[field] = { selector, value: value.slice(0, 120) }
        break
      }
    }

    return { fields, stats }
  }, FIELD_CANDIDATES)
}
