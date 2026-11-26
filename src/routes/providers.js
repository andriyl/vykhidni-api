import { listProviders, setProviderEnabled } from '../providers.js'

export default async function providerRoutes (fastify) {
  fastify.get('/providers', async () => listProviders())

  fastify.patch('/providers/:id', async (request, reply) => {
    const { id } = request.params
    const body = request.body || {}
    if (typeof body.enabled !== 'boolean') {
      return reply.code(400).send({ error: 'enabled must be boolean' })
    }
    const updated = setProviderEnabled(id, body.enabled)
    if (!updated) return reply.code(404).send({ error: 'Provider not found' })
    return updated
  })
}
