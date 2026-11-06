import { chromium } from 'playwright'
import { analyzeListing, detectFields, detectDetailFields } from './analyze.js'
import { detectStructured, extractDetail, extractItems, getAction, normalizeActions } from '../scanner/extract.js'
import { validateEvents } from './validate.js'
import { pruneHtml, refineWithLLM } from './llm.js'

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
const MICRODATA_ITEM_SELECTOR = '[itemtype*="schema.org/Event"]'
const HAS_YEAR_RE = /\d{4}/

function siteNameFromTitle (title, startUrl) {
  const cleaned =
    typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : ''
  if (cleaned) return cleaned.slice(0, 120)

  try {
    return new URL(startUrl).hostname
  } catch {
    return ''
  }
}

export function normalizeStartUrl (value) {
  if (!value || typeof value !== 'string') {
    throw new Error('URL is required')
  }
  let url = value.trim()
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.toString()
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

function mergeFields (current, extra) {
  const merged = { ...(current || {}) }
  const next = normalizeFields(extra) || {}
  for (const [field, chain] of Object.entries(next)) {
    if (!merged[field] || merged[field].length === 0) {
      merged[field] = chain
    }
  }
  return merged
}

/**
 * Для лістингу LLM може не лише додати нове поле, а й замінити поганий
 * евристичний селектор. Порівнюємо оцінки, які порахував detectFields().
 */
function mergeDetectedFields (current, currentStats, extra, nextStats) {
  const merged = { ...(current || {}) }
  const stats = { ...(currentStats || {}) }
  const next = normalizeFields(extra) || {}

  for (const [field, chain] of Object.entries(next)) {
    const hasCurrent = Array.isArray(merged[field]) && merged[field].length > 0
    const currentScore = stats[field]?.score ?? 0
    const nextScore = nextStats?.[field]?.score ?? 0

    if (!hasCurrent || nextScore > currentScore + 0.05) {
      merged[field] = chain
      if (nextStats?.[field]) stats[field] = nextStats[field]
    }
  }

  return { fields: merged, stats }
}

async function safeGoto (page, url, { timeout = 45000 } = {}) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
  try { await page.waitForLoadState('networkidle', { timeout: 8000 }) } catch {}
  await page.waitForTimeout(1200)
  return response
}

async function autoScroll (page, rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
    await page.waitForTimeout(900)
  }
}

async function expandLoadMore (page, pagination, maxClicks = 4) {
  if (pagination?.mode !== 'loadMore' || !pagination.selector) return 0
  let clicks = 0
  for (let i = 0; i < maxClicks; i += 1) {
    const clicked = await page.evaluate((selector) => {
      let el = null
      try { el = document.querySelector(selector) } catch { return false }
      if (!el) return false
      const target = el.tagName === 'BUTTON' || el.tagName === 'A' ? el : (el.querySelector('button,a') || el)
      if (!target || target.offsetParent === null) return false
      target.scrollIntoView({ block: 'center' })
      target.click()
      return true
    }, pagination.selector)
    if (!clicked) break
    await page.waitForTimeout(1800)
    clicks += 1
  }
  return clicks
}

async function itemSnippets (page, selector, limit = 2) {
  try {
    return await page.evaluate(({ selector, limit }) => [...document.querySelectorAll(selector)].slice(0, limit).map(el => el.outerHTML), { selector, limit })
  } catch { return [] }
}

async function detailSnippet (page) {
  try {
    return await page.evaluate(() => {
      const root = document.querySelector('article') || document.querySelector('main') || document.body
      return root ? root.innerHTML : ''
    })
  } catch { return '' }
}

function buildActions ({ listing, itemSelector, link, fields, sourceType, detail }) {
  const actions = []
  const pagination = listing.pagination || { mode: 'none' }
  const cleanFields = { ...(fields || {}) }
  delete cleanFields.link
  if (pagination.mode === 'url') actions.push({ type: 'paginate', mode: 'url', selector: pagination.selector || null, param: pagination.param || 'page', maxPages: 5 })
  else if (pagination.mode === 'loadMore') actions.push({ type: 'paginate', mode: 'loadMore', selector: pagination.selector || null, text: pagination.text || null, maxPages: 10 })
  actions.push({ type: 'extractListItems', item: itemSelector, link: link || ['[itemprop="url"]', 'a[href]'], fields: cleanFields, source: sourceType === 'microdata' ? 'microdata' : 'fields' })
  actions.push({ type: 'extractDetails', url: detail?.url || null, source: 'auto', fields: detail?.fields || {} })
  if (pagination.seedUrls?.length) actions.push({ type: 'seedUrls', urls: pagination.seedUrls })
  return actions
}

export async function discoverSite (rawUrl, { log = () => {}, useLLM = true, maxItems = 20 } = {}) {
  const startUrl = normalizeStartUrl(rawUrl)
  const startedAt = new Date()
  const warnings = []
  let llmCalls = 0

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1440, height: 1000 }, locale: 'uk-UA' })

  try {
    log(`🌐 Відкриваємо ${startUrl}`)
    const page = await context.newPage()
    await safeGoto(page, startUrl)
    await autoScroll(page)

    log('🔍 Аналізуємо структуру сторінки...')
    let listing = await analyzeListing(page)

    if (listing.pagination?.mode === 'loadMore') {
      log('➕ Розгортаємо «Показати ще»...')
      const clicks = await expandLoadMore(page, listing.pagination)
      if (clicks) { await autoScroll(page, 1); listing = await analyzeListing(page) }
    }

    let sourceType = 'heuristic'
    let itemSelector = null
    let link = ['[itemprop="url"]', 'a[href]']

    if (listing.structured?.microdataEvents >= 3) {
      sourceType = 'microdata'
      itemSelector = MICRODATA_ITEM_SELECTOR
    } else {
      const candidate = listing.candidates?.find(e => e.linkRatio >= 0.6 && e.score > 0) || listing.candidates?.[0]
      if (!candidate) throw new Error('Не вдалося знайти список подій на сторінці (немає повторюваних карток)')
      if (candidate.linkRatio < 0.6) warnings.push(`Лише ${Math.round(candidate.linkRatio * 100)}% карток мають посилання`)
      itemSelector = candidate.selector
      listing.chosenCandidate = candidate
    }

    log(`🧩 Знайдено картки: ${itemSelector}`)
    const detected = await detectFields(page, itemSelector, { limit: 8 })
    let fields = detected.fields || {}
    let fieldStats = detected.stats || {}

    if (!fields.title) warnings.push('Не вдалося визначити селектор title евристикою')
    if (!fields.date) warnings.push('Не вдалося визначити селектор date евристикою')

    const extractRecipe = () => ({ item: itemSelector, link, fields, source: sourceType === 'microdata' ? 'microdata' : 'fields' })
    let preview = (await extractItems(page, extractRecipe())).slice(0, maxItems)
    let validation = validateEvents(preview)

    const missing = ['title', 'date', 'image', 'location', 'description'].filter(f => (validation.fill?.[f] || 0) < 0.85)
    if (useLLM && (validation.score < 0.8 || !fields.title || !fields.date || missing.includes('title') || missing.includes('date'))) {
      log('🤖 Уточнюємо селектори через Gemini...')
      const snippets = (await itemSnippets(page, itemSelector, 2)).map(s => pruneHtml(s))
      const refined = await refineWithLLM({ itemSnippets: snippets, currentFields: fields, missingFields: [...new Set([...missing, 'title', 'date', 'image'])], kind: 'listing' })
      llmCalls += 1
      if (refined?.item) {
        const count = await page.evaluate((sel) => document.querySelectorAll(sel).length, refined.item).catch(() => 0)
        if (count >= 3) { itemSelector = refined.item; link = refined.link || link } else warnings.push('LLM запропонував item-селектор, який не знайшов карток')
      }
      if (refined?.fields || refined?.item) {
        const tested = await detectFields(page, itemSelector, {
          limit: 8,
          candidates: refined?.fields || undefined
        })
        const merged = mergeDetectedFields(
          fields,
          fieldStats,
          tested.fields,
          tested.stats
        )
        fields = merged.fields
        fieldStats = merged.stats
      }
      preview = (await extractItems(page, extractRecipe())).slice(0, maxItems)
      validation = validateEvents(preview)
    }

    const detailUrl = preview.find(e => e.url)?.url || null
    const detail = { url: detailUrl, source: 'auto', fields: {}, structured: null }
    if (detailUrl) {
      log(`📄 Аналізуємо сторінку події: ${detailUrl}`)
      const detailPage = await context.newPage()
      try {
        await safeGoto(detailPage, detailUrl)
        detail.structured = await detectStructured(detailPage)
        const detectedDetail = await detectDetailFields(detailPage)
        detail.fields = detectedDetail.fields || {}
        detail.event = await extractDetail(detailPage, { source: 'auto', fields: detail.fields })
        const currentDetail = validateEvents([detail.event])
        detail.validation = currentDetail
        const detailMissing = ['title', 'date', 'location', 'image', 'description'].filter(f => (currentDetail.fill?.[f] || 0) < 1)
        // Якщо microdata частковий або поля не знайдені - обов'язково використовуємо LLM для детальної сторінки
        if (useLLM && llmCalls < 4 && detailMissing.length) {
          log('🤖 Пошук полів на сторінці події через LLM...')
          const snippet = pruneHtml(await detailSnippet(detailPage), 14000)
          const refined = await refineWithLLM({ detailSnippet: snippet, currentFields: detail.fields, missingFields: detailMissing, kind: 'detail' })
          llmCalls += 1
          if (refined?.fields) {
            detail.fields = mergeFields(detail.fields, refined.fields)
            detail.event = await extractDetail(detailPage, { source: 'auto', fields: detail.fields })
          }
        }
      } catch (e) { warnings.push(`Не вдалося проаналізувати сторінку події: ${e.message}`) } finally { await detailPage.close().catch(() => {}) }
    }

    // Автодозаповнення дітейлів під час дискавері прибрано. Тільки перевірка зі списку.

    if (!validation.total) warnings.push('Попередній прогін не знайшов жодної події')
    if (validation.futureRate === 0 && validation.dateRate > 0) warnings.push('Усі знайдені дати в минулому — перевірте, чи це архів, а не афіша')

    const actions = buildActions({ listing, itemSelector, link, fields, sourceType, detail })
    const finishedAt = new Date()
    const report = {
      status: 'done',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      url: startUrl,
      finalUrl: page.url(),
      pageTitle: listing.title,
      sourceType,
      itemSelector,
      fieldStats,
      structured: listing.structured,
      candidates: (listing.candidates || []).slice(0, 5),
      chosenCandidate: listing.chosenCandidate || null,
      pagination: listing.pagination,
      detail: { url: detail.url, source: detail.source, fields: detail.fields, structured: detail.structured, sample: detail.event || null },
      validation,
      warnings: [...new Set(warnings)],
      llmCalls,
      preview: preview.slice(0, 12)
    }

    return { name: siteNameFromTitle(listing.title, startUrl), startUrl, actions, sourceType, confidence: validation.score, report }
  } finally { await browser.close().catch(() => {}) }
}

export async function previewSiteConfig (config, { limit = 10, details = true, log = () => {} } = {}) {
  const actions = normalizeActions(config.actions)
  const listAction = getAction(actions, 'extractListItems')
  if (!listAction) throw new Error('Конфіг не містить дії extractListItems')
  const paginate = getAction(actions, 'paginate')
  const detailAction = getAction(actions, 'extractDetails') || { source: 'auto', fields: {} }

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: 1440, height: 1000 }, locale: 'uk-UA' })
  try {
    const page = await context.newPage()
    await safeGoto(page, config.startUrl)
    await autoScroll(page)
    if (paginate?.mode === 'loadMore') { const clicks = await expandLoadMore(page, paginate, 2); if (clicks) await page.waitForTimeout(1000) }
    const events = (await extractItems(page, listAction)).slice(0, limit)
    if (details) {
      const needsDetail = events.filter(e => !e.description || !e.location || !e.image || (e.date && !HAS_YEAR_RE.test(e.date))).slice(0, 5)
      for (const event of needsDetail) {
        const detailPage = await context.newPage()
        try {
          log(`📄 ${event.url}`)
          await safeGoto(detailPage, event.url)
          const detail = await extractDetail(detailPage, detailAction)
          if (detail.date && HAS_YEAR_RE.test(detail.date) && (!event.date || !HAS_YEAR_RE.test(event.date))) event.date = detail.date
          for (const key of ['title', 'time', 'location', 'description', 'image']) if (!event[key] && detail[key]) event[key] = detail[key]
        } catch (e) { log(`⚠️ Не вдалося відкрити детейл: ${e.message}`) } finally { await detailPage.close().catch(() => {}) }
      }
    }
    return { events, validation: validateEvents(events) }
  } finally { await browser.close().catch(() => {}) }
}
