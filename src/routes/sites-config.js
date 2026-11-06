import { prisma } from '../db/prisma.js'
import { broadcastLog } from '../utils.js'
import {
  discoverSite,
  normalizeStartUrl,
  previewSiteConfig
} from '../discovery/discover.js'
import { getScanState, stopScan } from '../scanner/scanner.js'

const activeDiscoveries = new Set()

function parseId (value) {
  const id = Number(value)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Запустити асинхронний дискавері для існуючого чи щойно створеного SiteConfig.
 * Прогрес виводиться через broadcastLog (/logs WS) та зберігається в discoveryReport.
 */
async function runDiscoveryJob (id, url, { name, useLLM = true, previous = null } = {}) {
  const log = (message) => broadcastLog(`[#${id}] ${message}`)

  try {
    const result = await discoverSite(url, { log, useLLM })

    const updated = await prisma.siteConfig.update({
      where: { id },
      data: {
        name: name || result.name,
        actions: result.actions,
        sourceType: result.sourceType,
        confidence: result.confidence,
        discoveryReport: result.report,
        lastValidatedAt: new Date(),
        status: 'REVIEW',
        isActive: false
      }
    })

    await prisma.siteConfigVersion
      .create({
        data: {
          siteConfigId: id,
          actions: result.actions,
          sourceType: result.sourceType,
          note: 'Auto-discovery'
        }
      })
      .catch((error) => log(`⚠️ Не вдалося зберегти версію конфігу: ${error.message}`))

    log(
      `✅ Дискавері завершено: ${result.report.validation.total} подій, ` +
        `confidence ${result.confidence}. Сайт у статусі REVIEW.`
    )
    return updated
  } catch (error) {
    log(`❌ Дискавері не вдалося: ${error.message}`)

    // Не залишаємо раніше робочий сайт вимкненим через невдалий дискавері.
    await prisma.siteConfig
      .update({
        where: { id },
        data: {
          status: previous?.status || 'FAILED',
          isActive: previous?.isActive ?? false,
          discoveryReport: {
            status: 'failed',
            error: error.message,
            finishedAt: new Date().toISOString()
          }
        }
      })
      .catch(() => {})

    return null
  } finally {
    activeDiscoveries.delete(id)
  }
}

export default async function siteConfigRoutes (fastify) {
  fastify.get('/site_configs', async (request, reply) => {
    const { _start, _end } = request.query

    const start = Number.parseInt(_start, 10)
    const end = Number.parseInt(_end, 10)
    const skip = Number.isInteger(start) && start >= 0 ? start : 0
    const take = Number.isInteger(end) && end > skip ? end - skip : 10

    const [data, total] = await Promise.all([
      prisma.siteConfig.findMany({
        skip,
        take,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.siteConfig.count()
    ])

    reply
      .header('X-Total-Count', total.toString())
      .header('Access-Control-Expose-Headers', 'X-Total-Count')

    return data
  })

  fastify.get('/site_configs/:id', async (request, reply) => {
    const id = parseId(request.params.id)
    if (!id) return reply.code(400).send({ error: 'Invalid SiteConfig id' })

    const config = await prisma.siteConfig.findUnique({
      where: { id }
    })

    if (!config) {
      return reply.code(404).send({ error: 'SiteConfig not found' })
    }

    return config
  })

  // Ручне створення конфігу прибрано. Використовується лише автодискавері.

  /**
   * Старт авто-дискавері. Тільки автоматичний спосіб.
   * Якщо сайт вже існує — оновлюємо лише конфіг, події НЕ скануємо/НЕ дозаповнюємо.
   * Назва має бути задана користувачем вручну.
   */
  fastify.post('/site_configs/discover', async (request, reply) => {
    const { url, name, useLLM = true } = request.body || {}

    let startUrl
    try {
      startUrl = normalizeStartUrl(url)
    } catch (error) {
      return reply.code(400).send({ error: error.message })
    }

    const trimmedName = String(name || '').trim()
    if (!trimmedName) {
      return reply.code(400).send({ error: "Назва сайту обов'язкова" })
    }

    try {
      const existing = await prisma.siteConfig.findUnique({
        where: { startUrl }
      })

      if (existing && activeDiscoveries.has(existing.id)) {
        return reply.code(409).send({
          error: 'Дискавері для цього сайту вже виконується'
        })
      }

      const previous = existing
        ? { status: existing.status, isActive: existing.isActive }
        : null

      const config = await prisma.siteConfig.upsert({
        where: { startUrl },
        create: {
          name: trimmedName,
          startUrl,
          actions: [],
          isActive: false,
          status: 'DRAFT',
          discoveryReport: {
            status: 'running',
            startedAt: new Date().toISOString(),
            url: startUrl
          }
        },
        update: {
          name: trimmedName,
          discoveryReport: {
            status: 'running',
            startedAt: new Date().toISOString(),
            url: startUrl
          }
        }
      })

      if (activeDiscoveries.has(config.id)) {
        return reply.code(409).send({
          error: 'Дискавері для цього сайту вже виконується'
        })
      }
      activeDiscoveries.add(config.id)

      broadcastLog(
        existing
          ? `🔄 Оновлюємо конфіг існуючого сайту #${config.id}: ${startUrl}`
          : `🚀 Стартує авто-дискавері #${config.id}: ${startUrl}`
      )

      // Не запускаємо сканування автоматично - лише по кнопці в адмінці
      runDiscoveryJob(config.id, startUrl, {
        name: trimmedName,
        useLLM,
        previous
      }).catch((error) => {
        broadcastLog(`[#${config.id}] ❌ Неочікувана помилка дискавері: ${error.message}`)
      })

      return reply.code(202).send({
        id: config.id,
        status: 'discovering',
        startUrl,
        exists: !!existing
      })
    } catch (err) {
      console.error(err)
      if (err.code === 'P2002') {
        return reply.code(409).send({
          error: 'Сайт з таким URL вже створюється, спробуйте ще раз'
        })
      }
      return reply.code(500).send({ error: err.message })
    }
  })

  fastify.get('/site_configs/:id/discovery', async (request, reply) => {
    const id = parseId(request.params.id)
    if (!id) return reply.code(400).send({ error: 'Invalid SiteConfig id' })

    const config = await prisma.siteConfig.findUnique({
      where: { id }
    })

    if (!config) {
      return reply.code(404).send({ error: 'SiteConfig not found' })
    }

    return {
      id: config.id,
      name: config.name,
      startUrl: config.startUrl,
      status: config.status,
      isActive: config.isActive,
      sourceType: config.sourceType,
      confidence: config.confidence,
      actions: config.actions,
      report: config.discoveryReport,
      lastValidatedAt: config.lastValidatedAt,
      updatedAt: config.updatedAt
    }
  })

  // Сухий прогін збереженого конфігу: нічого не пише в Event.
  fastify.get('/site_configs/:id/preview', async (request, reply) => {
    const id = parseId(request.params.id)
    if (!id) return reply.code(400).send({ error: 'Invalid SiteConfig id' })

    const config = await prisma.siteConfig.findUnique({
      where: { id }
    })

    if (!config) {
      return reply.code(404).send({ error: 'SiteConfig not found' })
    }

    const requestedLimit = Number.parseInt(request.query.limit, 10)
    const limit = Math.min(
      Math.max(Number.isInteger(requestedLimit) ? requestedLimit : 10, 1),
      50
    )
    const details = request.query.details !== 'false'

    try {
      const result = await previewSiteConfig(config, {
        limit,
        details,
        log: (message) => broadcastLog(`[#${id}] ${message}`)
      })
      return {
        id: config.id,
        name: config.name,
        startUrl: config.startUrl,
        ...result
      }
    } catch (error) {
      return reply.code(400).send({ error: error.message })
    }
  })

  fastify.post('/site_configs/:id/activate', async (request, reply) => {
    const id = parseId(request.params.id)
    if (!id) return reply.code(400).send({ error: 'Invalid SiteConfig id' })

    try {
      const updated = await prisma.siteConfig.update({
        where: { id },
        data: { isActive: true, status: 'ACTIVE' }
      })

      await prisma.siteConfigVersion
        .create({
          data: {
            siteConfigId: id,
            actions: updated.actions,
            sourceType: updated.sourceType,
            note: 'Activated after review'
          }
        })
        .catch((error) => {
          broadcastLog(
            `[#${id}] ⚠️ Не вдалося зберегти версію конфігу: ${error.message}`
          )
        })

      broadcastLog(`✅ Сайт #${id} активовано: ${updated.name}`)
      // Не запускаємо сканування автоматично - лише по кнопці в адмінці
      return updated
    } catch (err) {
      console.error(err)
      return reply.code(404).send({ error: 'SiteConfig not found' })
    }
  })

  fastify.post('/site_configs/:id/deactivate', async (request, reply) => {
    const id = parseId(request.params.id)
    if (!id) return reply.code(400).send({ error: 'Invalid SiteConfig id' })

    try {
      const updated = await prisma.siteConfig.update({
        where: { id },
        data: { isActive: false, status: 'REVIEW' }
      })
      return updated
    } catch (err) {
      console.error(err)
      return reply.code(404).send({ error: 'SiteConfig not found' })
    }
  })

  // Стан сканування та зупинка
  fastify.get('/scan/state', async (request, reply) => {
    return getScanState()
  })

  fastify.post('/scan/stop', async (request, reply) => {
    try {
      const result = await stopScan('admin')
      return result
    } catch (err) {
      console.error(err)
      return reply.code(500).send({ error: err.message })
    }
  })

  fastify.patch('/site_configs/:id', async (request, reply) => {
    const id = parseId(request.params.id)
    if (!id) return reply.code(400).send({ error: 'Invalid SiteConfig id' })

    const body = request.body || {}
    const { name, startUrl, actions, isActive } = body
    const data = {}

    if (name !== undefined) {
      const value = String(name).trim()
      if (!value) return reply.code(400).send({ error: 'Назва не може бути порожньою' })
      data.name = value
    }

    if (startUrl !== undefined) {
      try {
        data.startUrl = normalizeStartUrl(startUrl)
      } catch (error) {
        return reply.code(400).send({ error: error.message })
      }
    }

    if (actions !== undefined) {
      if (!Array.isArray(actions)) {
        return reply.code(400).send({ error: 'actions має бути масивом' })
      }
      data.actions = actions
    }

    if (isActive !== undefined) {
      if (typeof isActive !== 'boolean') {
        return reply.code(400).send({ error: 'isActive має бути boolean' })
      }
      data.isActive = isActive
      data.status = isActive ? 'ACTIVE' : 'REVIEW'
    }

    if (!Object.keys(data).length) {
      return reply.code(400).send({ error: 'Немає полів для оновлення' })
    }

    try {
      const updated = await prisma.siteConfig.update({
        where: { id },
        data
      })

      if (Array.isArray(actions)) {
        await prisma.siteConfigVersion
          .create({
            data: {
              siteConfigId: updated.id,
              actions,
              sourceType: updated.sourceType,
              note: 'Manual edit'
            }
          })
          .catch((error) => {
            broadcastLog(
              `[#${id}] ⚠️ Не вдалося зберегти версію конфігу: ${error.message}`
            )
          })
      }

      return updated
    } catch (err) {
      console.error(err)
      if (err.code === 'P2025') {
        return reply.code(404).send({ error: 'SiteConfig not found' })
      }
      if (err.code === 'P2002') {
        return reply.code(409).send({
          error: 'Сайт з таким startUrl вже існує'
        })
      }
      return reply
        .code(500)
        .send({ error: 'SiteConfig not found or cannot update' })
    }
  })

  fastify.delete('/site_configs/:id', async (request, reply) => {
    const id = parseId(request.params.id)
    if (!id) return reply.code(400).send({ error: 'Invalid SiteConfig id' })

    try {
      const existing = await prisma.siteConfig.findUnique({
        where: { id },
        select: { id: true }
      })
      if (!existing) {
        return reply.code(404).send({ error: 'SiteConfig not found' })
      }

      // Видаляємо сайт разом з його подіями в одній транзакції.
      // Це очікувана поведінка кнопки «Видалити» в адмінці: інакше сайт
      // неможливо прибрати, доки в нього залишаються відскановані події.
      const [deletedEvents] = await prisma.$transaction([
        prisma.event.deleteMany({ where: { siteConfigId: id } }),
        prisma.siteConfig.delete({ where: { id } })
      ])

      return { success: true, deletedEvents: deletedEvents.count }
    } catch (err) {
      console.error(err)
      if (err.code === 'P2025') {
        return reply.code(404).send({ error: 'SiteConfig not found' })
      }
      return reply
        .code(500)
        .send({ error: 'SiteConfig not found or cannot delete' })
    }
  })
}
