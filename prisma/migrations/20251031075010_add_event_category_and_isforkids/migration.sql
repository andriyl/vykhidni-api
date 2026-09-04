-- AlterEnum
ALTER TYPE "public"."EventStatus" ADD VALUE 'APPROVED_BY_AI';

-- AlterTable
ALTER TABLE "public"."Event" ADD COLUMN     "category" TEXT,
ADD COLUMN     "isForKids" BOOLEAN;
