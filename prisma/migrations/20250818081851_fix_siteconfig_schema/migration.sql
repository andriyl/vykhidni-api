/*
  Warnings:

  - You are about to drop the `Site` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SiteAction` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `siteConfigId` to the `Event` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "public"."SiteAction" DROP CONSTRAINT "SiteAction_siteId_fkey";

-- AlterTable
ALTER TABLE "public"."Event" ADD COLUMN     "siteConfigId" INTEGER NOT NULL,
ALTER COLUMN "date" DROP NOT NULL,
ALTER COLUMN "time" DROP NOT NULL,
ALTER COLUMN "location" DROP NOT NULL,
ALTER COLUMN "description" DROP NOT NULL,
ALTER COLUMN "image" DROP NOT NULL;

-- DropTable
DROP TABLE "public"."Site";

-- DropTable
DROP TABLE "public"."SiteAction";

-- CreateTable
CREATE TABLE "public"."SiteConfig" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "startUrl" TEXT NOT NULL,
    "actions" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteConfig_pkey" PRIMARY KEY ("id")
);
