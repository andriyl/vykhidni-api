import { chromium } from 'playwright'
import { MICRODATA_ITEM_SELECTOR, probeListing } from './probe.js'
import {
  extractDetail,
  extractItems
} from '../scanner/extract.js'
import {
  proposeRecipe,
  pruneHtml,
  refineDetail,
  repairRecipe
} from './llm.js'
import {
  autoScroll,
  safeGoto,
  USER_AGENT
} from '../scanner/browser.js'

const MAX_LLM_CALLS = 3
const MIN_REPAIR_ITEMS = 3
const DETAIL_FIELDS = ['title', 'date', 'location', 'image', 'description']

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

function choosePagination (candidates = []) {
  const url =
    candidates.find((entry) => entry?.kind === 'url' && entry.selector) ||
    candidates.find((entry) => entry?.kind === 'url')
  const loadMore =
    candidates.find((entry) => entry?.kind === 'loadMore' && entry.selector) ||
    candidates.find((entry) => entry?.kind === 'loadMore')
  return url || loadMore || null
}

function toPagination (candidate) {
  if (!candidate) return { mode: 'none' }
  if (candidate.kind === 'loadMore') {
    return {
      mode: 'loadMore',
      selector: candidate.selector || null,
      text: candidate.text || null
    }
  }
  return {
    mode: 'url',
    selector: candidate.selector || null,
    param: candidate.param || 'page'
  }
}

function fallbackRecipe (candidate, pagination) {
  return {
    item: candidate?.selector || null,
    link: ['a[href]'],
    fields: {},
    source: candidate?.selector === MICRODATA_ITEM_SELECTOR
      ? 'microdata'
      : 'fields',
    pagination
  }
}

function recipeFromDecision (decision, candidates, pagination) {
  if (!decision?.item) return null
  const allowed = new Set(candidates.map((candidate) => candidate.selector))
  if (!allowed.has(decision.item)) return null

  const chosenPagination =
    decision.pagination && decision.pagination.mode !== 'none'
      ? decision.pagination
      : pagination.selector
        ? pagination
        : { mode: 'none' }

  return {
    item: decision.item,
    link: decision.link || ['a[href]'],
    fields: decision.fields || {},
    source: decision.item === MICRODATA_ITEM_SELECTOR
      ? 'microdata'
      : 'fields',
    pagination: chosenPagination
  }
}

async function mergeRecipe (current, decision, page) {
  const next = { ...current }
  if (decision.item) {
    const count = await page
      .evaluate((selector) => {
        try {
          return document.querySelectorAll(selector).length
        } catch {
          return 0
        }
      }, decision.item)
      .catch(() => 0)
    if (count >= 3 || decision.item === MICRODATA_ITEM_SELECTOR) {
      next.item = decision.item
    }
  }
  if (decision.link) next.link = decision.link
  if (decision.fields) next.fields = { ...(current.fields || {}), ...decision.fields }
  if (decision.pagination) next.pagination = decision.pagination
  next.source = next.item === MICRODATA_ITEM_SELECTOR ? 'microdata' : 'fields'
  return next
}

function candidateReport (candidate) {
  if (!candidate) return null
  const { selector, count, linkRatio, imageRatio, dateRatio, avgText, score } =
    candidate
  return { selector, count, linkRatio, imageRatio, dateRatio, avgText, score }
}

function buildActions ({
  pagination,
  item,
  link,
  fields,
  source,
  detail,
  seedUrls
}) {
  const actions = []
  if (pagination?.mode === 'url') {
    actions.push({
      type: 'paginate',
      mode: 'url',
      selector: pagination.selector || null,
      param: pagination.param || 'page',
      maxPages: 5
    })
  } else if (pagination?.mode === 'loadMore') {
    actions.push({
      type: 'paginate',
      mode: 'loadMore',
      selector: pagination.selector || null,
      text: pagination.text || null,
      maxPages: 10
    })
  }

  actions.push({
    type: 'extractListItems',
    item,
    link: link || ['a[href]'],
    fields: fields || {},
    source: source === 'microdata' ? 'microdata' : 'fields'
  })
  actions.push({
    type: 'extractDetails',
    url: detail?.url || null,
    source: 'auto',
    fields: detail?.fields || {}
  })
  if (seedUrls?.length) actions.push({ type: 'seedUrls', urls: seedUrls })
  return actions
}

async function detailSnippet (page) {
  try {
    return await page.evaluate(() => {
      const root =
        document.querySelector('article') ||
        document.querySelector('main') ||
        document.body
      return root ? root.innerHTML : ''
    })
  } catch {
    return ''
  }
}

export async function discoverSite (
  rawUrl,
  { log = () => {}, useLLM = true } = {}
) {
  const startUrl = normalizeStartUrl(rawUrl)
  const startedAt = new Date()
  const warnings = []
  let llmCalls = 0
  let llmTokens = 0

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1440, height: 1000 },
    locale: 'uk-UA'
  })

  try {
    log(`🌐 Відкриваємо ${startUrl}`)
    const page = await context.newPage()
    await safeGoto(page, startUrl)
    await autoScroll(page)

    log('🔍 Аналізуємо структуру сторінки...')
    const probe = await probeListing(page)
    const candidates = (probe.candidates || []).slice(0, 3)
    const defaultPagination = toPagination(
      choosePagination(probe.pagination)
    )

    let recipe = null
    let sourceType = 'heuristic'

    // Fast path: microdata listing. No LLM needed when the data is complete.
    if (probe.structured?.microdataEvents >= 3) {
      const microdataRecipe = {
        item: MICRODATA_ITEM_SELECTOR,
        link: ['[itemprop="url"]', 'a[href]'],
        fields: {},
        source: 'microdata',
        pagination: defaultPagination
      }
      const sample = await extractItems(page, microdataRecipe)
      if (sample.length >= MIN_REPAIR_ITEMS) {
        recipe = microdataRecipe
        sourceType = 'microdata'
        log(`✅ Знайдено microdata-картки: ${sample.length}`)
      }
    }

    // LLM path, or a deterministic fallback when LLM is disabled.
    if (!recipe) {
      if (!candidates.length) {
        throw new Error(
          'Не вдалося знайти список подій на сторінці (немає повторюваних карток)'
        )
      }

      if (!useLLM) {
        recipe = fallbackRecipe(candidates[0], defaultPagination)
        warnings.push(
          'LLM вимкнено — використано першого кандидата та загальні селектори'
        )
      } else {
        log('🤖 Підбираємо селектори через Gemini...')
        const { data, usage } = await proposeRecipe({
          url: startUrl,
          title: probe.title,
          candidates: candidates.map((candidate) => ({
            selector: candidate.selector,
            count: candidate.count,
            html: pruneHtml(candidate.html, 1800)
          })),
          pagination: probe.pagination || [],
          structured: probe.structured
        })
        llmCalls += 1
        llmTokens += usage?.totalTokenCount || 0

        recipe = recipeFromDecision(data, candidates, defaultPagination)
        if (recipe) {
          sourceType =
            recipe.item === MICRODATA_ITEM_SELECTOR ? 'microdata' : 'llm'
        }
        if (!recipe) {
          warnings.push(
            'LLM не повернув валідний рецепт — використано евристичний fallback'
          )
          recipe = fallbackRecipe(candidates[0], defaultPagination)
        }
      }
    }

    let preview = await extractItems(page, recipe)

    // One repair call when extraction yields too few cards. Acceptance is
    // based only on the number of extracted events, not on field quality.
    const chosen =
      candidates.find((candidate) => candidate.selector === recipe.item) ||
      candidates[0]
    const tooFew =
      preview.length === 0 ||
      (chosen?.count >= MIN_REPAIR_ITEMS && preview.length < MIN_REPAIR_ITEMS)

    if (tooFew && useLLM && llmCalls < MAX_LLM_CALLS) {
      log('🤖 Уточнюємо селектори за результатами перевірки...')
      const { data, usage } = await repairRecipe({
        cardHtml: pruneHtml(chosen?.html || '', 2200),
        sample: preview.slice(0, 3),
        failures: ['item', 'title', 'date'],
        current: {
          item: recipe.item,
          link: recipe.link,
          fields: recipe.fields
        }
      })
      llmCalls += 1
      llmTokens += usage?.totalTokenCount || 0

      if (data) {
        const repaired = await mergeRecipe(recipe, data, page)
        const repairedPreview = await extractItems(page, repaired)
        if (repairedPreview.length > preview.length) {
          recipe = repaired
          preview = repairedPreview
          if (repaired.item !== MICRODATA_ITEM_SELECTOR) sourceType = 'llm'
        }
      }
    }

    if (!preview.length) warnings.push('Не знайдено жодної події')

    // Detail page: generic + structured data first, LLM only as a fallback.
    const detailUrl = preview.find((event) => event.url)?.url || null
    const detail = {
      url: detailUrl,
      source: 'auto',
      fields: {},
      structured: null,
      event: null
    }

    if (detailUrl) {
      log(`📄 Аналізуємо сторінку події: ${detailUrl}`)
      const detailPage = await context.newPage()
      try {
        await safeGoto(detailPage, detailUrl)
        const first = await extractDetail(
          detailPage,
          { source: 'auto', fields: {} },
          { withMeta: true }
        )
        detail.structured = first.structured
        let detailEvent = first.event
        const missing = DETAIL_FIELDS.filter((field) => !detailEvent?.[field])

        if (useLLM && missing.length && llmCalls < MAX_LLM_CALLS) {
          log('🤖 Уточнюємо поля сторінки події через Gemini...')
          const { data, usage } = await refineDetail({
            detailHtml: pruneHtml(await detailSnippet(detailPage), 6000),
            currentFields: {},
            missingFields: missing
          })
          llmCalls += 1
          llmTokens += usage?.totalTokenCount || 0

          if (data?.fields) {
            detail.fields = data.fields
            detailEvent = await extractDetail(detailPage, {
              source: 'auto',
              fields: data.fields
            })
          }
        }

        detail.event = detailEvent
      } catch (error) {
        warnings.push(
          `Не вдалося проаналізувати сторінку події: ${error.message}`
        )
      } finally {
        await detailPage.close().catch(() => {})
      }
    }

    const previewEvent = preview[0] ? { ...preview[0] } : null
    if (previewEvent && detail.event) {
      if (detail.event.date && !previewEvent.date) {
        previewEvent.date = detail.event.date
      }
      for (const key of ['title', 'time', 'location', 'image']) {
        if (!previewEvent[key] && detail.event[key]) previewEvent[key] = detail.event[key]
      }
      if (
        detail.event.description &&
        (!previewEvent.description ||
          detail.event.description.length > previewEvent.description.length)
      ) {
        previewEvent.description = detail.event.description
      }
    }

    const pagination = recipe.pagination || { mode: 'none' }
    const actions = buildActions({
      pagination,
      item: recipe.item,
      link: recipe.link,
      fields: recipe.fields,
      source: recipe.source,
      detail,
      seedUrls: probe.seedUrls
    })

    const finishedAt = new Date()
    const chosenCandidate =
      (probe.candidates || []).find(
        (candidate) => candidate.selector === recipe.item
      ) || null

    const report = {
      status: 'done',
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
      url: startUrl,
      finalUrl: page.url(),
      pageTitle: probe.title,
      sourceType,
      itemSelector: recipe.item,
      total: preview.length,
      structured: probe.structured,
      candidates: (probe.candidates || [])
        .slice(0, 5)
        .map(candidateReport),
      chosenCandidate: candidateReport(chosenCandidate),
      pagination,
      detail,
      preview: previewEvent,
      warnings: [...new Set(warnings)],
      llmCalls,
      llmTokens
    }

    return {
      name: '',
      startUrl,
      actions,
      sourceType,
      report
    }
  } finally {
    await browser.close().catch(() => {})
  }
}
