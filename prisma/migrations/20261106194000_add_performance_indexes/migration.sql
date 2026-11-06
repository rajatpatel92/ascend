-- CreateIndex
CREATE INDEX "Account_platformId_idx" ON "Account"("platformId");

-- CreateIndex
CREATE INDEX "Activity_investmentId_idx" ON "Activity"("investmentId");

-- CreateIndex
CREATE INDEX "Activity_accountId_idx" ON "Activity"("accountId");

-- CreateIndex
CREATE INDEX "Activity_date_idx" ON "Activity"("date");

-- CreateIndex
CREATE INDEX "HiddenDividend_symbol_idx" ON "HiddenDividend"("symbol");
