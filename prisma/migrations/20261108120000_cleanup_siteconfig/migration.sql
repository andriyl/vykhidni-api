DROP TABLE "SiteConfigVersion";

ALTER TABLE "SiteConfig"
  DROP COLUMN "confidence",
  DROP COLUMN "lastValidatedAt",
  DROP COLUMN "lastRunStats";
