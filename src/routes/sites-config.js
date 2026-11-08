import { prisma } from '../db/prisma.js'
import { broadcastLog } from '../utils.js'
import {
  discoverSite,
  normalizeStartUrl
} from '../discovery/discover.js'
import { getScanState, stopScan } from '../scanner/scanner.js'

const activeDiscoveries = new Set()

const NOT_FOUND = 'SiteConfig not found'
const INVALID_ID = 'Invalid SiteConfig id'

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
        discoveryReport: result.report,
        status: 'REVIEW'
      }
    })

    log(
      `✅ Дискавері завершено: ${result.report.total} подій. ` +
        'Сайт у статусі REVIEW.'
    )
    return updated
  } catch (error) {
    log(`❌ Дискавері не вдалося: ${error.message}`)

    await prisma.siteConfig
      .update({
        where: { id },
        data: {
          status: previous ? previous.status : 'FAILED',
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

    const where = { deletedAt: null }

    const [data, total] = await Promise.all([
      prisma.siteConfig.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' }
      }),
      prisma.siteConfig.count({ where })
    ])

    reply
      .header('X-Total-Count', total.toString())
      .header('Access-Control-Expose-Headers', 'X-Total-Count')

    return data
  })

  fastify.get('/site_configs/:id', async (request, reply) => {
    const id = parseId(request.params.id)
    if (!id) return reply.code(400).send({ error: INVALID_ID })

    const config = await prisma.siteConfig.findFirst({
      where: { id, deletedAt: null }
    })

    if (!config) {
      return reply.code(404).send({ error: NOT_FOUND })
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
        ? { status: existing.status }
        : null

      const config = await prisma.siteConfig.upsert({
        where: { startUrl },
        create: {
          name: trimmedName,
          startUrl,
          actions: [],
          status: 'DRAFT',
          discoveryReport: {
            status: 'running',
            startedAt: new Date().toISOString(),
            url: startUrl
          }
        },
        update: {
          name: trimmedName,
          // Повторне додавання м'яко видаленого сайту відновлює його.
          deletedAt: null,
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
      fastify.log.error(err)
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
    if (!id) return reply.code(400).send({ error: INVALID_ID })

    const config = await prisma.siteConfig.findFirst({
      where: { id, deletedAt: null }
    })

    if (!config) {
      return reply.code(404).send({ error: NOT_FOUND })
    }

    return {
      id: config.id,
      name: config.name,
      startUrl: config.startUrl,
      status: config.status,
      sourceType: config.sourceType,
      actions: config.actions,
      report: config.discoveryReport,
      updatedAt: config.updatedAt
    }
  })

  fastify.post('/site_configs/:id/activate', async (request, reply) => {
    const id = parseId(request.params.id)
    if (!id) return reply.code(400).send({ error: INVALID_ID })

    try {
      const existing = await prisma.siteConfig.findFirst({
        where: { id, deletedAt: null },
        select: { id: true }
      })
      if (!existing) {
        return reply.code(404).send({ error: NOT_FOUND })
      }

      const updated = await prisma.siteConfig.update({
        where: { id },
        data: { status: 'ACTIVE' }
      })

      broadcastLog(`✅ Сайт #${id} активовано: ${updated.name}`)
      // Не запускаємо сканування автоматично - лише по кнопці в адмінці
      return updated
    } catch (err) {
      fastify.log.error(err)
      return reply.code(404).send({ error: NOT_FOUND })
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
      fastify.log.error(err)
      return reply.code(500).send({ error: err.message })
    }
  })

  fastify.patch('/site_configs/:id', async (request, reply) => {
    const id = parseId(request.params.id)
    if (!id) return reply.code(400).send({ error: INVALID_ID })

    const body = request.body || {}
    const { name, startUrl, actions, status } = body
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

    if (status !== undefined) {
      const allowed = ['ACTIVE', 'REVIEW', 'DRAFT', 'FAILED']
      if (typeof status !== 'string' || !allowed.includes(status)) {
        return reply.code(400).send({ error: 'Некоректний status' })
      }
      data.status = status
    }

    if (!Object.keys(data).length) {
      return reply.code(400).send({ error: 'Немає полів для оновлення' })
    }

    try {
      const existing = await prisma.siteConfig.findFirst({
        where: { id, deletedAt: null },
        select: { id: true }
      })
      if (!existing) {
        return reply.code(404).send({ error: NOT_FOUND })
      }

      const updated = await prisma.siteConfig.update({
        where: { id },
        data
      })

      return updated
    } catch (err) {
      fastify.log.error(err)
      if (err.code === 'P2025') {
        return reply.code(404).send({ error: NOT_FOUND })
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
    if (!id) return reply.code(400).send({ error: INVALID_ID })

    try {
      const existing = await prisma.siteConfig.findFirst({
        where: { id, deletedAt: null },
        select: { id: true }
      })
      if (!existing) {
        return reply.code(404).send({ error: NOT_FOUND })
      }

      // М'яке видалення: конфіг ховається зі списків та вибірок, але події
      // залишаються прив'язаними до нього. Повторне додавання того ж
      // startUrl через /site_configs/discover відновлює конфіг.
      await prisma.siteConfig.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          status: 'ARCHIVED'
        }
      })

      return { success: true }
    } catch (err) {
      fastify.log.error(err)
      if (err.code === 'P2025') {
        return reply.code(404).send({ error: NOT_FOUND })
      }
      return reply
        .code(500)
        .send({ error: 'SiteConfig not found or cannot delete' })
    }
  })
}
