-- CreateIndex
CREATE UNIQUE INDEX "SiteConfig_startUrl_key" ON "public"."SiteConfig"("startUrl");

-- DropEnum
DROP TYPE "public"."EventStatus";
