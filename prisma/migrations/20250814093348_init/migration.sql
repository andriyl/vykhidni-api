-- CreateTable
CREATE TABLE "public"."Event" (
    "id" SERIAL NOT NULL,
    "title" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "time" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Site" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "startUrl" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SiteAction" (
    "id" SERIAL NOT NULL,
    "siteId" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "selector" TEXT NOT NULL,
    "field" TEXT,
    "order" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SiteAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Event_url_key" ON "public"."Event"("url");

-- AddForeignKey
ALTER TABLE "public"."SiteAction" ADD CONSTRAINT "SiteAction_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "public"."Site"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
