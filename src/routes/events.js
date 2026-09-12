import { PrismaClient } from '@prisma/client'
import 'dotenv/config'
import { getCoordinates, toUnix } from '../utils.js'

const prisma = new PrismaClient()

// GET /events?_start=0&_end=10
export default async function eventRoutes (fastify) {
  fastify.get('/events', async (request, reply) => {
    const { _start, _end, status, siteConfigId } = request.query

    const where = {}
    if (status) {
      const statuses = status.split(',').map(s => s.trim())
      where.status = { in: statuses }
    }
    if (siteConfigId) where.siteConfigId = parseInt(siteConfigId, 10)

    const usePagination = _start !== undefined && _end !== undefined

    const skip = usePagination ? parseInt(_start, 10) : undefined
    const take = usePagination ? parseInt(_end, 10) - parseInt(_start, 10) : undefined

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
    const { id } = request.params

    const event = await prisma.event.findUnique({
      where: { id: parseInt(id, 10) },
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
  fastify.post('/events', async (request, reply) => {
    try {
      const {
        title, date, time, location, description, image, url, siteConfigId
      } = request.body

      if (!title || !url || !siteConfigId) {
        return reply.code(400).send({ error: 'Missing required fields' })
      }

      const newEvent = await prisma.event.create({
        data: {
          title, date, time, location, description, image, url, siteConfigId
        }
      })

      return newEvent
    } catch (err) {
      console.error(err)
      return reply.code(500).send({ error: 'Server error' })
    }
  })

  fastify.patch('/events/:id', async (request, reply) => {
    const { id } = request.params
    const {
      title, date, time, location, description, image, url, status, siteConfigId
    } = request.body

    try {
      const existing = await prisma.event.findUnique({
        where: { id: parseInt(id, 10) }
      })

      if (!existing) {
        return reply.code(404).send({ error: 'Event not found' })
      }

      const dataToUpdate = {
        title, date, time, location, description, image, url, siteConfigId, status
      }

      if (existing.status === 'DRAFT' && status === 'APPROVED') {
        const coords = await getCoordinates(location)
        console.log('LOCATION', location)
        console.log('COORDS', coords)

        dataToUpdate.unixTime = toUnix(date, time) || null
        dataToUpdate.coordinates = coords ? `${coords.lat},${coords.lon}` : null
      }

      console.log('DATA_TO_UPDATE', dataToUpdate)

      const updated = await prisma.event.update({
        where: { id: parseInt(id, 10) }, data: dataToUpdate
      })

      console.log('UPDATED', updated)
      return updated
    } catch (err) {
      console.error(err)
      return reply
        .code(500)
        .send({ error: 'Event not found or cannot update' })
    }
  })

  // DELETE /events/:id
  fastify.delete('/events/:id', async (request, reply) => {
    const { id } = request.params

    try {
      await prisma.event.delete({
        where: { id: parseInt(id, 10) }
      })

      return { success: true }
    } catch (err) {
      console.error(err)
      return reply
        .code(404)
        .send({ error: 'Event not found or cannot delete' })
    }
  })
}
