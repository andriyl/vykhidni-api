import Fastify from "fastify";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import cron from "node-cron";
import { scanSites } from "./scanner/scanner.js";
import siteConfigRoutes from "./routes/sites-config.js";
import eventRoutes from "./routes/events.js";
import aiFunctionsRoutes from "./routes/aiFunctions.js";
import {addLogClient} from "./utils.js";

const fastify = Fastify({ logger: true });

await fastify.register(fastifyCors, {
  origin: ["http://localhost:5173", "http://localhost:5174"],
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
});

await fastify.register(fastifyWebsocket);

fastify.register(eventRoutes);
fastify.register(siteConfigRoutes);
fastify.register(aiFunctionsRoutes);


fastify.get("/logs", { websocket: true }, (socket, req) => {
  addLogClient({ socket, req });
});

fastify.get("/scan", async () => {
  const total = await scanSites();
  return { scanned: total };
});

// cron.schedule("0 2 * * *", async () => {
//   fastify.log.info("Running daily scan...");
//   const total = await scanSites();
//   fastify.log.info(`Daily scan completed. Scanned ${total} events.`);
// });

fastify.listen({ port: 3000 });
