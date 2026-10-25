import 'dotenv/config'
import Fastify from 'fastify'
import fastifyCors from '@fastify/cors'
import fastifyWebsocket from '@fastify/websocket'
import { scanSites } from './scanner/scanner.js'
import siteConfigRoutes from './routes/sites-config.js'
import eventRoutes from './routes/events.js'
import aiFunctionsRoutes from './routes/aiFunctions.js'
import { addLogClient, broadcastLog } from './utils.js'

const fastify = Fastify({ logger: true })

const defaultOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://127.0.0.1:5175'
]

const corsOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean)
  : defaultOrigins

await fastify.register(fastifyCors, {
  origin: corsOrigins,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS']
})

await fastify.register(fastifyWebsocket)

fastify.register(eventRoutes)
fastify.register(siteConfigRoutes)
fastify.register(aiFunctionsRoutes)

fastify.get('/logs', { websocket: true }, (socket, req) => {
  addLogClient({ socket, req })
})

async function runScan (reply, request) {
  try {
    const siteId = request?.query?.siteId || request?.body?.siteId
    broadcastLog(
      siteId ? `🕷️ Запускаємо скан сайту #${siteId}...` : '🕷️ Запускаємо скан сайтів...'
    )
    const total = await scanSites({ siteId })
    broadcastLog(`🎉 Скан завершено. Нових подій: ${total}`)
    return { scanned: total }
  } catch (err) {
    fastify.log.error(err)
    broadcastLog(`🔥 Помилка скану: ${err.message}`)
    return reply.code(500).send({ error: err.message })
  }
}

fastify.get('/scan', async (request, reply) => runScan(reply, request))
fastify.post('/scan', async (request, reply) => runScan(reply, request))

const port = Number(process.env.PORT) || 3000
const host = process.env.HOST || '127.0.0.1'

fastify.listen({ port, host })
