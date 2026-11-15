export const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

export async function safeGoto (page, url, { timeout = 45000 } = {}) {
  const response = await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout
  })
  try {
    await page.waitForLoadState('networkidle', { timeout: 8000 })
  } catch {}
  await page.waitForTimeout(1200)
  return response
}

export async function autoScroll (page, rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(900)
  }
}

/**
 * Click a "show more" control. The selector is preferred; text is used as a
 * fallback because sites often change generated class names.
 */
export async function clickLoadMore (page, action, maxClicks = 10) {
  const selector = action?.selector
  const text = action?.text
  if (!selector && !text) return 0

  let clicks = 0
  for (let i = 0; i < maxClicks; i += 1) {
    const clicked = await page.evaluate(
      ({ selector, text }) => {
        const clean = (value) =>
          value ? String(value).replace(/\s+/g, ' ').trim() : ''

        let el = null
        try {
          el = selector ? document.querySelector(selector) : null
        } catch {
          el = null
        }
        if (!el && text) {
          el = [...document.querySelectorAll('button,a')].find(
            (node) => clean(node.textContent) === text
          )
        }
        if (!el) return false

        const target =
          el.tagName === 'BUTTON' || el.tagName === 'A'
            ? el
            : el.querySelector('button,a') || el
        if (!target || target.offsetParent === null) return false

        target.scrollIntoView({ block: 'center' })
        target.click()
        return true
      },
      { selector, text: text || null }
    )

    if (!clicked) break
    await page.waitForTimeout(1500)
    clicks += 1
  }
  return clicks
}
