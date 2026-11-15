-- AlterTable
ALTER TABLE "public"."SiteConfig" ADD COLUMN     "deletedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "SiteConfig_deletedAt_idx" ON "public"."SiteConfig"("deletedAt");
