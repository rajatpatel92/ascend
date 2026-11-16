-- AlterTable
ALTER TABLE "MarketDataCache" ADD COLUMN     "historyUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "metadataUpdatedAt" TIMESTAMP(3);
