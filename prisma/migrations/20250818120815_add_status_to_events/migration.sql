-- CreateEnum
CREATE TYPE "public"."EventStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "public"."Event" ADD COLUMN     "status" "public"."EventStatus" NOT NULL DEFAULT 'DRAFT';
