-- AlterTable
ALTER TABLE "public"."SiteConfig" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "discoveryReport" JSONB,
ADD COLUMN     "lastRunStats" JSONB,
ADD COLUMN     "lastValidatedAt" TIMESTAMP(3),
ADD COLUMN     "sourceType" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- CreateTable
CREATE TABLE "public"."SiteConfigVersion" (
    "id" SERIAL NOT NULL,
    "siteConfigId" INTEGER NOT NULL,
    "actions" JSONB NOT NULL,
    "sourceType" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SiteConfigVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SiteConfigVersion_siteConfigId_idx" ON "public"."SiteConfigVersion"("siteConfigId");

-- AddForeignKey
ALTER TABLE "public"."SiteConfigVersion" ADD CONSTRAINT "SiteConfigVersion_siteConfigId_fkey" FOREIGN KEY ("siteConfigId") REFERENCES "public"."SiteConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
