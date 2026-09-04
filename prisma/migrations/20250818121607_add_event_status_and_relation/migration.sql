/*
  Warnings:

  - The `status` column on the `Event` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "public"."Event" DROP COLUMN "status",
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'DRAFT';

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_siteConfigId_fkey" FOREIGN KEY ("siteConfigId") REFERENCES "public"."SiteConfig"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
