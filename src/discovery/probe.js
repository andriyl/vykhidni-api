const MICRODATA_ITEM_SELECTOR = '[itemtype*="schema.org/Event"]'

/**
 * Collect facts about a listing page without trying to score or interpret
 * them. The LLM (or a simple fallback) decides which candidate to use.
 */
export async function probeListing (page) {
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

    const matchesExpectedCount = (selector, expected) => {
      try {
        const found = document.querySelectorAll(selector).length
        return (
          found >= Math.max(3, Math.floor(expected * 0.7)) &&
          found <= expected * 2 + 5
        )
      } catch {
        return false
      }
    }

    const uniqueSelector = (el) => {
      if (!el) return null
      if (el.id) return `#${CSS.escape(el.id)}`
      const tag = el.tagName.toLowerCase()
      const classes = stableClasses(el)
      const candidates = classes.length
        ? [
            `${tag}.${classes.map((name) => CSS.escape(name)).join('.')}`,
            `${tag}.${CSS.escape(classes[0])}`
          ]
        : [tag]
      for (const selector of candidates) {
        try {
          if (document.querySelectorAll(selector).length === 1) return selector
        } catch {}
      }
      // Returning null is safer than a selector that matches many elements:
      // callers can fall back to link scanning or button text.
      return null
    }

    const groupSelector = (parent, sample, expected) => {
      if (
        sample.getAttribute('itemtype')?.includes('schema.org/Event')
      ) {
        return '[itemtype*="schema.org/Event"]'
      }

      const tag = sample.tagName.toLowerCase()
      const classes = stableClasses(sample)
      const candidates = []

      if (sample.id) candidates.push(`#${CSS.escape(sample.id)}`)
      if (classes.length) {
        candidates.push(
          `${tag}.${classes.map((name) => CSS.escape(name)).join('.')}`
        )
        candidates.push(`${tag}.${CSS.escape(classes[0])}`)
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
              ? `.${parentClasses
                  .map((name) => CSS.escape(name))
                  .join('.')}`
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
        if (matchesExpectedCount(candidate, expected)) return candidate
      }
      return null
    }

    const signature = (el) => {
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

    const groups = new Map()
    for (const parent of document.querySelectorAll('body *')) {
      const children = [...parent.children]
      if (children.length < 3 || children.length > 120) continue

      const bySignature = new Map()
      for (const child of children) {
        const key = signature(child)
        if (!bySignature.has(key)) bySignature.set(key, [])
        bySignature.get(key).push(child)
      }

      for (const elements of bySignature.values()) {
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

        // Navigation menus and tag clouds are short sibling links.
        const looksLikeNav = elements.every(
          (el) =>
            el.tagName === 'A' && clean(el.textContent).length < 25
        )
        if (looksLikeNav) continue

        const score =
          count *
          (0.5 + linkRatio + dateRatio + imageRatio * 0.5) *
          (avgText > 20 && avgText < 1200 ? 1 : 0.4)

        const selector = groupSelector(parent, elements[0], count)
        if (!selector) continue

        const candidate = {
          selector,
          count,
          linkRatio: +linkRatio.toFixed(2),
          imageRatio: +imageRatio.toFixed(2),
          dateRatio: +dateRatio.toFixed(2),
          avgText: Math.round(avgText),
          score: Math.round(score * 10) / 10,
          html: elements[0].outerHTML.slice(0, 4000)
        }

        const previous = groups.get(selector)
        if (previous && previous.score >= candidate.score) continue
        groups.set(selector, candidate)
      }
    }

    const candidates = [...groups.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)

    const anchors = [...document.querySelectorAll('a[href]')]
    const pagination = []

    const nextAnchor = anchors.find(
      (el) =>
        el.getAttribute('rel') === 'next' ||
        /^(наступна|наступний|далі|next)$/i.test(clean(el.textContent))
    )
    if (nextAnchor) {
      pagination.push({
        kind: 'url',
        selector:
          nextAnchor.id
            ? `#${CSS.escape(nextAnchor.id)}`
            : nextAnchor.getAttribute('rel') === 'next'
              ? 'a[rel="next"]'
              : uniqueSelector(nextAnchor),
        param: 'page',
        text: clean(nextAnchor.textContent)
      })
    }

    const pageAnchors = anchors.filter((el) =>
      /[?&]page=\d+/i.test(el.getAttribute('href') || '')
    )
    if (pageAnchors.length) {
      pagination.push({
        kind: 'url',
        selector:
          groupSelector(
            pageAnchors[0].parentElement,
            pageAnchors[0],
            pageAnchors.length
          ) || uniqueSelector(pageAnchors[0]),
        param: 'page',
        text: ''
      })
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
    if (loadMore) {
      pagination.push({
        kind: 'loadMore',
        selector: uniqueSelector(loadMore),
        text: clean(loadMore.textContent)
      })
    }

    const seenPagination = new Set()
    const paginationCandidates = pagination.filter((entry) => {
      const key = `${entry.kind}|${entry.selector || ''}|${entry.text || ''}`
      if (seenPagination.has(key)) return false
      seenPagination.add(key)
      return true
    })

    // Date-bucket navigation (e.g. /search/NextWeek/) is not pagination,
    // but it is useful as extra seed URLs.
    const seedUrls = [
      ...new Set(
        anchors
          .map((el) => el.getAttribute('href'))
          .filter(
            (href) =>
              href &&
              (/\/(search|events?|afisha|podii|calendar)\/(today|tomorrow|thisweek|nextweek|weekend)/i.test(
                href
              ) ||
                /[?&]w=(today|tomorrow|thisweek|nextweek|weekend)/i.test(
                  href
                ))
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
    let hasEventJsonLd = false
    for (const script of document.querySelectorAll(
      'script[type="application/ld+json"]'
    )) {
      try {
        const walk = (value) => {
          if (Array.isArray(value)) return value.forEach(walk)
          if (!value || typeof value !== 'object') return
          if (value['@type']) {
            const types = Array.isArray(value['@type'])
              ? value['@type']
              : [value['@type']]
            for (const type of types) {
              ldTypes.push(String(type))
              if (String(type).includes('Event')) hasEventJsonLd = true
            }
          }
          Object.values(value).forEach((child) => {
            if (child && typeof child === 'object') walk(child)
          })
        }
        walk(JSON.parse(script.textContent))
      } catch {}
    }

    return {
      title: document.title,
      url: location.href,
      candidates,
      pagination: paginationCandidates,
      seedUrls,
      structured: {
        jsonLdTypes: [...new Set(ldTypes)],
        hasEventJsonLd,
        microdataEvents: document.querySelectorAll(
          '[itemtype*="schema.org/Event"]'
        ).length
      }
    }
  })
}

export { MICRODATA_ITEM_SELECTOR }
