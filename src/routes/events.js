import 'dotenv/config'
import { prisma } from '../db/prisma.js'

const EVENT_STATUSES = new Set([
  'DRAFT',
  'APPROVED',
  'APPROVED_BY_AI',
  'REJECTED'
])

// GET /events?_start=0&_end=10
export default async function eventRoutes (fastify) {
  fastify.get('/events', async (request, reply) => {
    const { _start, _end, status, siteConfigId, dateFrom, dateTo } = request.query

    const where = {}
    if (status) {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean)
      where.status = { in: statuses }
    }
    if (siteConfigId !== undefined) {
      const configId = Number.parseInt(siteConfigId, 10)
      if (!Number.isInteger(configId)) {
        return reply.code(400).send({ error: 'Invalid siteConfigId' })
      }
      where.siteConfigId = configId
    }
    if (dateFrom || dateTo) {
      where.unixTime = {}
      if (dateFrom) {
        const from = Number.parseInt(dateFrom, 10)
        if (!Number.isInteger(from)) {
          return reply.code(400).send({ error: 'Invalid dateFrom' })
        }
        where.unixTime.gte = from
      }
      if (dateTo) {
        const to = Number.parseInt(dateTo, 10)
        if (!Number.isInteger(to)) {
          return reply.code(400).send({ error: 'Invalid dateTo' })
        }
        where.unixTime.lte = to
      }
    }

    const usePagination = _start !== undefined && _end !== undefined
    let skip
    let take

    if (usePagination) {
      skip = Number.parseInt(_start, 10)
      const end = Number.parseInt(_end, 10)
      if (
        !Number.isInteger(skip) || skip < 0 ||
        !Number.isInteger(end) || end < skip
      ) {
        return reply.code(400).send({ error: 'Invalid _start/_end' })
      }
      take = end - skip
    }

    const [data, total] = await Promise.all([prisma.event.findMany({
      skip,
      take,
      orderBy: { createdAt: 'desc' },
      where,
      include: {
        siteConfig: { select: { name: true } }
      }
    }), prisma.event.count({ where })])

    reply
      .header('X-Total-Count', total.toString())
      .header('Access-Control-Expose-Headers', 'X-Total-Count')

    return data.map((event) => ({
      ...event, siteConfigName: event.siteConfig.name
    }))
  })

  // GET /events/:id
  fastify.get('/events/:id', async (request, reply) => {
    const eventId = Number.parseInt(request.params.id, 10)
    if (!Number.isInteger(eventId)) {
      return reply.code(400).send({ error: 'Invalid event id' })
    }

    const event = await prisma.event.findUnique({
      where: { id: eventId },
      include: {
        siteConfig: {
          select: { name: true }
        }
      }
    })

    if (!event) {
      return reply.code(404).send({ error: 'Event not found' })
    }

    return {
      ...event, siteConfigName: event.siteConfig.name
    }
  })

  // POST /events
  fastify.patch('/events/:id', async (request, reply) => {
    const eventId = Number.parseInt(request.params.id, 10)
    if (!Number.isInteger(eventId)) {
      return reply.code(400).send({ error: 'Invalid event id' })
    }

    const body = request.body || {}
    const editableFields = [
      'title', 'date', 'time', 'location', 'description', 'image', 'url',
      'status', 'siteConfigId'
    ]

    const dataToUpdate = {}
    for (const field of editableFields) {
      if (body[field] !== undefined) dataToUpdate[field] = body[field]
    }

    for (const field of [
      'title', 'date', 'time', 'location', 'description', 'image', 'url',
      'status'
    ]) {
      const value = dataToUpdate[field]
      if (value !== undefined && value !== null && typeof value !== 'string') {
        return reply.code(400).send({ error: `${field} має бути рядком` })
      }
    }

    if (
      dataToUpdate.title === null ||
      (dataToUpdate.title !== undefined && !String(dataToUpdate.title).trim())
    ) {
      return reply.code(400).send({ error: 'title не може бути порожнім' })
    }
    if (
      dataToUpdate.url === null ||
      (dataToUpdate.url !== undefined && !String(dataToUpdate.url).trim())
    ) {
      return reply.code(400).send({ error: 'url не може бути порожнім' })
    }
    if (
      dataToUpdate.status !== undefined &&
      !EVENT_STATUSES.has(dataToUpdate.status)
    ) {
      return reply.code(400).send({ error: 'Некоректний status' })
    }
    if (dataToUpdate.siteConfigId !== undefined) {
      const configId = Number(dataToUpdate.siteConfigId)
      if (!Number.isInteger(configId) || configId <= 0) {
        return reply.code(400).send({ error: 'Invalid siteConfigId' })
      }
      dataToUpdate.siteConfigId = configId
    }
    if (!Object.keys(dataToUpdate).length) {
      return reply.code(400).send({ error: 'Немає полів для оновлення' })
    }

    try {
      const existing = await prisma.event.findUnique({
        where: { id: eventId }
      })

      if (!existing) {
        return reply.code(404).send({ error: 'Event not found' })
      }

      const updated = await prisma.event.update({
        where: { id: eventId },
        data: dataToUpdate
      })

      return updated
    } catch (err) {
      fastify.log.error(err)
      if (err.code === 'P2025') {
        return reply.code(404).send({ error: 'Event not found' })
      }
      if (err.code === 'P2002') {
        return reply.code(409).send({ error: 'Подія з таким url вже існує' })
      }
      return reply.code(500).send({ error: 'Cannot update event' })
    }
  })

  // DELETE /events/:id
  fastify.delete('/events/:id', async (request, reply) => {
    const eventId = Number.parseInt(request.params.id, 10)
    if (!Number.isInteger(eventId)) {
      return reply.code(400).send({ error: 'Invalid event id' })
    }

    try {
      await prisma.event.delete({
        where: { id: eventId }
      })

      return { success: true }
    } catch (err) {
      fastify.log.error(err)
      return reply
        .code(404)
        .send({ error: 'Event not found or cannot delete' })
    }
  })
}
