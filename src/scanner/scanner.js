import { PlaywrightCrawler, RequestQueue, log } from 'crawlee'
import { prisma } from '../db/prisma.js'
import { broadcastLog, toUnix } from '../utils.js'
import {
  extractDetail,
  extractItems,
  getAction,
  normalizeActions
} from './extract.js'

const activeScanState = {
  running: false,
  stopped: false,
  reason: null,
  siteId: null,
  startedAt: null,
  crawlers: [],
  queues: []
}

export function getScanState () {
  return {
    running: activeScanState.running,
    stopped: activeScanState.stopped,
    reason: activeScanState.reason,
    siteId: activeScanState.siteId,
    startedAt: activeScanState.startedAt
  }
}

export async function stopScan (reason = 'manual') {
  if (!activeScanState.running) {
    return { stopped: false, message: 'Сканування не запущено' }
  }
  activeScanState.stopped = true
  activeScanState.reason = reason
  broadcastLog('⛔ Зупинка сканування за запитом з адмінки...')

  for (const crawler of activeScanState.crawlers) {
    try {
      if (typeof crawler.stop === 'function') {
        await crawler.stop()
      }
    } catch (e) {
      // ігноруємо помилки при зупинці
    }
  }
  for (const queue of activeScanState.queues) {
    try {
      if (typeof queue.drop === 'function') {
        await queue.drop()
      }
    } catch (e) {
      // ігноруємо помилки при зупинці
    }
  }
  return { stopped: true }
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

const DEFAULT_MAX_PAGES = 5
const DEFAULT_HYDRATE_LIMIT = 40

function pageNumber (url, param = 'page') {
  const escaped = String(param).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = url.match(new RegExp(`[?&]${escaped}=(\\d+)`))
  return match ? Number(match[1]) : 0
}

async function textOf (page, selector) {
  if (!selector) return ''
  try {
    const value = await page
      .locator(selector)
      .first()
      .textContent({ timeout: 5000 })
    return value?.trim() || ''
  } catch {
    return ''
  }
}

async function imageOf (page, selector) {
  if (!selector) return ''
  try {
    const locator = page.locator(selector).first()
    await locator.waitFor({ state: 'attached', timeout: 5000 })
    for (const attr of ['src', 'data-src', 'data-bg']) {
      const value = await locator.getAttribute(attr)
      if (value) return value.trim()
    }
    return ''
  } catch {
    return ''
  }
}

async function legacyExtractEvent (page, config) {
  return {
    title: await textOf(page, config.title),
    date: await textOf(page, config.date),
    time: await textOf(page, config.time),
    location: await textOf(page, config.location),
    description: await textOf(page, config.description),
    image: await imageOf(page, config.image),
    url: page.url()
  }
}

async function clickLoadMore (page, action, maxClicks = 10) {
  const selector = action?.selector
  if (!selector && !action?.text) return 0

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
      { selector, text: action?.text || null }
    )

    if (!clicked) break
    await page.waitForTimeout(1500)
    clicks += 1
  }
  return clicks
}

const HAS_YEAR_RE = /\d{4}/

function needsDetail (event) {
  return (
    !event.title ||
    !event.date ||
    !event.time ||
    !event.description ||
    !event.location ||
    !event.image ||
    (event.date && !HAS_YEAR_RE.test(event.date))
  )
}

async function hydrateEvent (page, event, detailAction) {
  if (!detailAction || !event.url || !needsDetail(event)) return event

  const detailPage = await page.context().newPage()
  try {
    await detailPage.goto(event.url, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    })
    const detail = await extractDetail(detailPage, detailAction)

    // A detail date with a year is authoritative for "29/10" style listing
    // dates, otherwise we could never build a timestamp.
    if (detail.date && HAS_YEAR_RE.test(detail.date)) {
      if (!event.date || !HAS_YEAR_RE.test(event.date)) {
        event.date = detail.date
      }
    }
    for (const key of [
      'title',
      'time',
      'location',
      'description',
      'image'
    ]) {
      if (!event[key] && detail[key]) event[key] = detail[key]
    }
  } catch (error) {
    log.warning(`Detail hydration failed for ${event.url}: ${error.message}`)
  } finally {
    await detailPage.close().catch(() => {})
  }
  return event
}

async function saveEvent (site, event, stats, seenUrls) {
  if (!event?.url) return false
  if (seenUrls.has(event.url)) {
    stats.skipped += 1
    return false
  }

  // Не перезаписуємо та не доповнюємо івенти, що вже затверджені
  const existing = await prisma.event.findUnique({
    where: { url: event.url },
    select: { id: true, status: true }
  }).catch(() => null)
  if (existing && (existing.status === 'APPROVED' || existing.status === 'APPROVED_BY_AI')) {
    seenUrls.add(event.url)
    stats.skipped += 1
    return false
  }

  try {
    if (existing) {
      // Якщо івент вже існує, але не затверджений - не оновлюємо (за вимогою), лише рахуємо
      seenUrls.add(event.url)
      stats.skipped += 1
      return false
    }

    const unixTime = toUnix(event.date, event.time)
    await prisma.event.create({
      data: {
        title: event.title || event.url,
        date: event.date || null,
        time: event.time || null,
        unixTime: unixTime ?? null,
        location: event.location || null,
        description: event.description || null,
        image: event.image || null,
        url: event.url,
        siteConfigId: site.id
      }
    })
    seenUrls.add(event.url)
    stats.saved += 1
    stats.fields.title += event.title ? 1 : 0
    stats.fields.date += event.date ? 1 : 0
    stats.fields.location += event.location ? 1 : 0
    stats.fields.image += event.image ? 1 : 0
    log.info(`✅ Saved: ${event.title || event.url}`)
    return true
  } catch (error) {
    if (error.code === 'P2002') {
      seenUrls.add(event.url)
      stats.skipped += 1
      log.warning(`⚠️ Already exists: ${event.url}`)
    } else {
      stats.errors += 1
      log.error(`❌ Error saving event: ${error.message}`)
    }
    return false
  }
}

/**
 * Сканер сайтів за конфігами SiteConfig.
 * Підтримує як новий формат (extractListItems + paginate/loadMore + seedUrls),
 * так і старий (extractList + extractDetails).
 * Зберігає події в БД, рахує unixTime, дозаповнює детейлами за потреби.
 */
export async function scanSites ({ siteId } = {}) {
  if (activeScanState.running) {
    throw new Error('Сканування вже запущено')
  }

  let numericSiteId = null
  if (siteId !== undefined && siteId !== null && siteId !== '') {
    numericSiteId = Number(siteId)
    if (!Number.isInteger(numericSiteId) || numericSiteId <= 0) {
      throw new Error('Некоректний siteId')
    }
  }

  activeScanState.running = true
  activeScanState.stopped = false
  activeScanState.reason = null
  activeScanState.siteId = numericSiteId
  activeScanState.startedAt = new Date().toISOString()
  activeScanState.crawlers = []
  activeScanState.queues = []

  let totalEvents = 0

  try {
    const sites = await prisma.siteConfig.findMany({
      where: numericSiteId ? { id: numericSiteId } : undefined
    })

    for (const site of sites) {
      if (activeScanState.stopped) {
        broadcastLog('⛔ Сканування зупинено')
        break
      }
      if (!site.isActive) {
        log.info(`⏸️ Skipping inactive site: ${site.name}`)
        broadcastLog(`⏸️ Пропускаємо неактивний сайт: ${site.name}`)
        continue
      }

      const actions = normalizeActions(site.actions)
      const paginationAction = getAction(actions, 'paginate')
      const listItemsAction = getAction(actions, 'extractListItems')
      const extractListAction = getAction(actions, 'extractList')
      const extractDetailsAction = getAction(actions, 'extractDetails')
      const seedUrlsAction = getAction(actions, 'seedUrls')
      const hydrateAction = getAction(actions, 'hydrateMissing')

      log.info(`🔍 Scanning site: ${site.name} (${site.startUrl})`)
      broadcastLog(`🔍 Скануємо сайт: ${site.name}`)

      const stats = {
        startedAt: new Date().toISOString(),
        finishedAt: null,
        pages: 0,
        itemsFound: 0,
        saved: 0,
        skipped: 0,
        errors: 0,
        fields: { title: 0, date: 0, location: 0, image: 0 }
      }

      const existingUrls = await prisma.event
        .findMany({
          where: { siteConfigId: site.id },
          select: { url: true }
        })
        .then((events) => events.map((event) => event.url))
      const seenUrls = new Set(existingUrls)
      const newEvents = []

      const configuredBudget = Number(hydrateAction?.maxPerRun)
      let hydrateBudget =
        hydrateAction?.maxPerRun !== undefined &&
        hydrateAction?.maxPerRun !== null &&
        Number.isFinite(configuredBudget)
          ? Math.max(0, configuredBudget)
          : DEFAULT_HYDRATE_LIMIT

      const queueName = `site-${site.id}`
      await (await RequestQueue.open(queueName)).drop().catch(() => {})
      const requestQueue = await RequestQueue.open(queueName)

      const saveFromList = async (page) => {
        const events = await extractItems(page, listItemsAction)
        stats.itemsFound += events.length

        for (const event of events) {
          if (seenUrls.has(event.url)) {
            stats.skipped += 1
            continue
          }
          const mandatoryMissing =
            Boolean(event.date && !HAS_YEAR_RE.test(event.date)) ||
            !event.description
          if (
            extractDetailsAction &&
            (mandatoryMissing || (hydrateBudget > 0 && needsDetail(event)))
          ) {
            await hydrateEvent(page, event, extractDetailsAction)
            if (!mandatoryMissing) {
              hydrateBudget = Math.max(0, hydrateBudget - 1)
            }
          }
          if (await saveEvent(site, event, stats, seenUrls)) {
            newEvents.push(event)
          }
        }
      }

      try {
        if (activeScanState.stopped) break
        const crawler = new PlaywrightCrawler({
          requestQueue,
          maxConcurrency: 3,
          maxRequestRetries: 1,
          navigationTimeoutSecs: 30,
          requestHandlerTimeoutSecs: 120,
          launchContext: {
            userAgent: USER_AGENT
          },
          async requestHandler ({ page, request, enqueueLinks }) {
            if (activeScanState.stopped) {
              throw new Error('SCAN_STOPPED')
            }
            stats.pages += 1
            log.debug(
            `🧭 Visited [${request.label || 'LIST'}] ${request.url}`
            )

            // ---------- New recipe format ----------
            if (listItemsAction) {
              if (request.label !== 'DETAIL') {
                if (paginationAction?.mode === 'loadMore') {
                  const clicks = await clickLoadMore(
                    page,
                    paginationAction,
                    Number(paginationAction.maxPages) || 10
                  )
                  if (clicks) {
                    log.info(`➕ Loaded more: ${clicks} click(s)`)
                  }
                }

                if (paginationAction?.mode !== 'loadMore') {
                  try {
                    const maxPages =
                      Number(paginationAction?.maxPages) || DEFAULT_MAX_PAGES
                    const param = paginationAction?.param || 'page'
                    const depth = Number(request.userData?.pageDepth || 0)

                    const enqueuePagination = (options) =>
                      enqueueLinks({
                        ...options,
                        transformRequestFunction: (req) => {
                          if (depth + 1 > maxPages) return null
                          const page = pageNumber(req.url, param)
                          if (page && page > maxPages) return null
                          req.userData = {
                            ...(req.userData || {}),
                            pageDepth: depth + 1
                          }
                          return req
                        },
                        label: 'PAGINATION'
                      })

                    if (paginationAction?.selector) {
                      await enqueuePagination({
                        selector: paginationAction.selector
                      })
                    } else if (paginationAction) {
                      const escapedParam = param.replace(
                        /[.*+?^${}()|[\]\\]/g,
                        '\\$&'
                      )
                      const links = await page.$$eval(
                        'a[href]',
                        (elements, pattern) => {
                          const re = new RegExp(pattern)
                          return elements
                            .map((el) => el.href)
                            .filter((href) => re.test(href))
                        },
                        `[?&]${escapedParam}=\\d+`
                      )
                      for (const link of links) {
                        await enqueuePagination({ urls: [link] })
                      }
                    }
                  } catch (error) {
                    log.warning(
                    `Pagination failed on ${request.url}: ${error.message}`
                    )
                  }
                }

                await saveFromList(page)
              }
              return
            }

            // ---------- Legacy recipe format ----------
            if (paginationAction && request.label !== 'DETAIL') {
              try {
                const maxPages =
                  Number(paginationAction.maxPages) || DEFAULT_MAX_PAGES
                const param = paginationAction.param || 'page'
                const depth = Number(request.userData?.pageDepth || 0)

                await enqueueLinks({
                  selector: paginationAction.selector,
                  transformRequestFunction: (req) => {
                    if (depth + 1 > maxPages) return null
                    if (!req.url.includes(`${param}=`)) return null
                    if (pageNumber(req.url, param) > maxPages) return null
                    req.userData = {
                      ...(req.userData || {}),
                      pageDepth: depth + 1
                    }
                    return req
                  },
                  label: 'PAGINATION'
                })
              } catch (error) {
                log.warning(
                `Pagination failed on ${request.url}: ${error.message}`
                )
              }
            }

            if (extractListAction && request.label !== 'DETAIL') {
              try {
                const links = await page.$$eval(
                  extractListAction.selector,
                  (elements) =>
                    elements
                      .map((el) => el.getAttribute('href') || el.href)
                      .filter(Boolean)
                )

                log.info(`🔗 Found ${links.length} links on list page`)

                for (const href of links) {
                  const url = new URL(href, request.url).toString()
                  if (!existingUrls.includes(url)) {
                    await enqueueLinks({ urls: [url], label: 'DETAIL' })
                  }
                }
              } catch (error) {
                log.warning(
                `List extraction failed on ${request.url}: ${error.message}`
                )
              }
            }

            if (extractDetailsAction && request.label === 'DETAIL') {
              const event = await legacyExtractEvent(page, extractDetailsAction)
              log.debug(`📄 Extracted event: ${event.title}`)

              if (await saveEvent(site, event, stats, seenUrls)) {
                newEvents.push(event)
              }
            }
          }
        })

        const urls = [site.startUrl]
        if (Array.isArray(seedUrlsAction?.urls)) {
          for (const seed of seedUrlsAction.urls) {
            try {
              urls.push(new URL(seed, site.startUrl).toString())
            } catch {
            // ignore malformed seed URL
            }
          }
        }

        activeScanState.crawlers.push(crawler)
        activeScanState.queues.push(requestQueue)
        try {
          await crawler.run([...new Set(urls)])
        } catch (e) {
          if (e?.message === 'SCAN_STOPPED' || activeScanState.stopped) {
            log.info('Сканування зупинено')
          } else {
            throw e
          }
        }
      } finally {
        await requestQueue.drop().catch(() => {})
      }

      stats.finishedAt = new Date().toISOString()
      stats.total = newEvents.length

      await prisma.siteConfig
        .update({
          where: { id: site.id },
          data: { lastRunStats: stats }
        })
        .catch(() => {})

      log.info(`📦 ${site.name}: saved ${newEvents.length} events`)
      broadcastLog(
      `📦 ${site.name}: нових подій ${newEvents.length}` +
        (stats.skipped ? `, пропущено ${stats.skipped}` : '')
      )
      totalEvents += newEvents.length
    }
  } finally {
    activeScanState.running = false
    activeScanState.crawlers = []
    activeScanState.queues = []
  }

  if (activeScanState.stopped) {
    broadcastLog('⛔ Сканування зупинено користувачем')
    return totalEvents
  }

  log.info(`🎉 Done! Total new events: ${totalEvents}`)
  broadcastLog(`🎉 Всього нових подій: ${totalEvents}`)
  return totalEvents
}
