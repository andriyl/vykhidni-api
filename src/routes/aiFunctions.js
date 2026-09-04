import {PrismaClient} from "@prisma/client";
import {model} from "../gemini.js";
import {broadcastLog, getCoordinates, toUnix} from "../utils.js";


const prisma = new PrismaClient();

export default async function aiFunctionsRoutes(fastify) {

  fastify.post("/validate-by-ai", async (request, reply) => {
    broadcastLog("🤖 Починаємо валідацію через AI...");
    try {
      const events = await prisma.event.findMany({
        where: {status: "DRAFT"},
      });

      if (!events.length) {
        return {message: "Немає подій для валідації"};
      }

      const results = [];

      for (const ev of events) {
        try {
          const prompt = `
        Ти — AI, який нормалізує та класифікує дані подій.
        Приведи значення до правильного формату:
        - title: коротка назва події (текст)
        - date: у форматі YYYY-MM-DD
        - time: у форматі HH:mm або порожнє
        - location: чітке місце проведення
        - description: максимум 500 символів, без тегів
        - image: URL або порожнє
        - category: вибери одну з типових категорій (музика, мистецтво, спорт, театр, конференція, фестиваль, освіта, майстерклас, книги, інша)
        - isForKids: true якщо подія орієнтована на дітей (казки, мультфільми, сімейні заходи, цирк, дитячі майстер-класи, тощо), інакше false.

        Вхідні дані (JSON):
        ${JSON.stringify(ev, null, 2)}

        Відповідай ТІЛЬКИ валідним JSON без коментарів.
        `;

          const aiResponse = await model.generateContent(prompt);
          const text = aiResponse.response.text();
          const cleaned = text.replace(/```json|```/g, "").trim();

          let parsed;
          try {
            parsed = JSON.parse(cleaned);
          } catch {
            console.warn("⚠️ AI повернув невалідний JSON:", text);
            continue;
          }

          const dataToUpdate = {
            ...parsed,
            status: "APPROVED_BY_AI",
          };

          if (ev.status === "DRAFT") {
            const coords = await getCoordinates(parsed.location);
            dataToUpdate.unixTime = toUnix(parsed.date, parsed.time) || null;
            dataToUpdate.coordinates = coords ? `${coords.lat},${coords.lon}` : null;
          }

          const updated = await prisma.event.update({
            where: {id: ev.id},
            data: dataToUpdate,
          });

          console.log(`✅ Оновлено подію: ${updated.title}`);
          broadcastLog(`✅ Оновлено подію: ${updated.title}`);
          results.push(updated);

          await new Promise((r) => setTimeout(r, 2000));
        } catch (innerErr) {
          console.error("❌ Помилка при обробці події:", ev.id, innerErr.message);
          broadcastLog("❌ Помилка при обробці події:", ev.id, innerErr.message);

          try {
            await prisma.event.update({
              where: {id: ev.id},
              data: {aiProcessed: false},
            });
          } catch {
          }

          await new Promise((r) => setTimeout(r, 5000));
        }
      }

      return {
        message: `Оброблено ${results.length} подій`,
        updated: results,
      };
    } catch (err) {
      console.error("🔥 Глобальна помилка:", err);
      broadcastLog("🔥 Глобальна помилка:", err);
      reply.status(500).send({error: "Помилка при валідації подій"});
    }
  });


}
