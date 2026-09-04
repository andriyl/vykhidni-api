import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export default async function siteConfigRoutes(fastify) {
  fastify.get("/site_configs", async (request, reply) => {
    const { _start, _end } = request.query;

    const skip = _start ? parseInt(_start, 10) : 0;
    const take = _end && _start ? parseInt(_end, 10) - skip : 10;

    const [data, total] = await Promise.all([
      prisma.siteConfig.findMany({
        skip,
        take,
        orderBy: { createdAt: "desc" },
      }),
      prisma.siteConfig.count(),
    ]);
    console.log("DATA", data);

    reply
      .header("X-Total-Count", total.toString())
      .header("Access-Control-Expose-Headers", "X-Total-Count");

    return data;
  });

  fastify.get("/site_configs/:id", async (request, reply) => {
    const { id } = request.params;

    const config = await prisma.siteConfig.findUnique({
      where: { id: parseInt(id, 10) },
    });

    if (!config) {
      return reply.code(404).send({ error: "SiteConfig not found" });
    }

    return config;
  });

  fastify.post("/site_configs", async (request, reply) => {
    try {
      const { name, startUrl, actions } = request.body;

      if (!name || !startUrl || !actions) {
        return reply.code(400).send({ error: "Missing fields" });
      }

      const newConfig = await prisma.siteConfig.create({
        data: {
          name,
          startUrl,
          actions,
        },
      });

      return newConfig;
    } catch (err) {
      console.error(err);
      return reply.code(500).send({ error: "Server error" });
    }
  });

  fastify.patch("/site_configs/:id", async (request, reply) => {
    const { id } = request.params;
    const { name, startUrl, actions, isActive } = request.body;

    try {
      const updated = await prisma.siteConfig.update({
        where: { id: parseInt(id, 10) },
        data: { name, startUrl, actions, isActive },
      });
      return updated;
    } catch (err) {
      console.error(err);
      return reply
        .code(404)
        .send({ error: "SiteConfig not found or cannot update" });
    }
  });

  fastify.delete("/site_configs/:id", async (request, reply) => {
    const { id } = request.params;

    try {
      await prisma.siteConfig.delete({
        where: { id: parseInt(id, 10) },
      });
      return { success: true };
    } catch (err) {
      console.error(err);
      return reply
        .code(404)
        .send({ error: "SiteConfig not found or cannot delete" });
    }
  });
}
