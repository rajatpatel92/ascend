import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { deflateRawSync } from 'node:zlib';
import { resetHostCircuitBreakersForTests } from './http.ts';
import {
    bmoAdapter,
    fetchBmoAllocationsWithDate,
    parseBmoHoldingsSheet,
    resolveBmoTickerCandidates,
} from './bmo.ts';

function xmlEscape(val: string): string {
    return val
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function buildBmoXlsxBuffer(rows: Array<Array<string | number>>): Buffer {
    const rowXml = rows
        .map((cells, rIdx) => {
            const cellXml = cells
                .map((cell, cIdx) => {
                    const col = String.fromCharCode(65 + cIdx);
                    const ref = `${col}${rIdx + 1}`;
                    if (typeof cell === 'number') {
                        return `<c r="${ref}"><v>${cell}</v></c>`;
                    }
                    return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(cell)}</t></is></c>`;
                })
                .join('');
            return `<row r="${rIdx + 1}">${cellXml}</row>`;
        })
        .join('');

    const workbookXml = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Holdings" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const relsXml = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`;
    const sheetXml = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`;

    const files = [
        { name: 'xl/workbook.xml', content: Buffer.from(workbookXml, 'utf8') },
        { name: 'xl/_rels/workbook.xml.rels', content: Buffer.from(relsXml, 'utf8') },
        { name: 'xl/worksheets/sheet1.xml', content: Buffer.from(sheetXml, 'utf8') },
    ];

    const localChunks: Buffer[] = [];
    const centralChunks: Buffer[] = [];
    let offset = 0;

    for (const file of files) {
        const nameBuf = Buffer.from(file.name, 'utf8');
        const compressed = deflateRawSync(file.content);

        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(compressed.length, 18);
        local.writeUInt32LE(file.content.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        nameBuf.copy(local, 30);
        localChunks.push(local, compressed);

        const central = Buffer.alloc(46 + nameBuf.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(compressed.length, 20);
        central.writeUInt32LE(file.content.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt32LE(offset, 42);
        nameBuf.copy(central, 46);
        centralChunks.push(central);

        offset += local.length + compressed.length;
    }

    const centralDir = Buffer.concat(centralChunks);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralDir.length, 12);
    eocd.writeUInt32LE(offset, 16);

    return Buffer.concat([...localChunks, centralDir, eocd]);
}

function binaryResponse(buf: Buffer): Response {
    return new Response(new Uint8Array(buf), {
        status: 200,
        headers: {
            'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        },
    });
}

describe('BMO GAM Canada direct-issuer adapter', () => {
    beforeEach(() => {
        resetHostCircuitBreakersForTests();
    });

    test('canHandle & ticker candidate resolution', () => {
        assert.deepStrictEqual(resolveBmoTickerCandidates('ZEA.TO'), ['ZEA']);
        assert.deepStrictEqual(resolveBmoTickerCandidates('ZUAG-F.TO'), [
            'ZUAG-F',
            'ZUAG.F',
            'ZUAG',
        ]);
        assert.strictEqual(resolveBmoTickerCandidates('SPY'), null);

        assert.strictEqual(
            bmoAdapter.canHandle({ symbol: 'ZEA.TO', quoteType: 'ETF', fundName: 'BMO MSCI EAFE Index ETF' }),
            true
        );
        assert.strictEqual(
            bmoAdapter.canHandle({ symbol: 'ZBAL.TO', quoteType: 'ETF', fundName: 'BMO Balanced ETF' }),
            true
        );
        assert.strictEqual(
            bmoAdapter.canHandle({ symbol: 'ZMMK.TO', quoteType: 'ETF', fundName: 'BMO Money Market Fund ETF Series' }),
            false
        );
        assert.strictEqual(
            bmoAdapter.canHandle({ symbol: 'ZGLD.TO', quoteType: 'ETF', fundName: 'BMO Gold Bullion ETF' }),
            false
        );
        assert.strictEqual(
            bmoAdapter.canHandle({ symbol: 'BMO.TO', quoteType: 'EQUITY', fundName: 'Bank of Montreal' }),
            false
        );
        assert.strictEqual(
            bmoAdapter.canHandle({ symbol: 'QUU.TO', quoteType: 'ETF', fundName: 'Mackenzie US Large Cap' }),
            false
        );
        assert.strictEqual(
            bmoAdapter.canHandle({ symbol: 'XEQT.TO', quoteType: 'ETF' }),
            false
        );
    });

    test('parses single-ETF XLSX (ZEM.TO) rejecting KY offshore domiciles & cash', async () => {
        const zemXlsx = buildBmoXlsxBuffer([
            ['BMO MSCI Emerging Markets Index ETF'],
            ['As of', '2026-11-17'],
            ['Name', 'ISIN', 'CUSIP', 'Asset Class', 'Sector', 'Currency', 'Weight (%)', 'Base Market Value'],
            ['TAIWAN SEMICONDUCTOR', 'TW0002330008', '', 'Equities', 'Information Technology', 'TWD', 40, 400000],
            ['TENCENT HOLDINGS', 'KYG875721634', '', 'Equities', 'Communication Services', 'HKD', 20, 200000],
            ['SAMSUNG ELECTRONICS', 'KR7005930003', '', 'Equities', 'Information Technology', 'KRW', 30, 300000],
            ['CASH', '', '', 'Cash', 'Cash', 'CAD', 10, 100000],
            ['Total', '', '', '', '', '', 100, 1000000],
        ]);

        const mockFetch: typeof fetch = async (input) => {
            const url = String(input);
            if (url.includes('Holdings_Extract_en_US_ZEM_20261117.xlsx')) {
                return binaryResponse(zemXlsx);
            }
            return new Response('Not Found', { status: 404 });
        };

        const res = await fetchBmoAllocationsWithDate(
            {
                symbol: 'ZEM.TO',
                quoteType: 'ETF',
                fundName: 'BMO MSCI Emerging Markets Index ETF',
                fetchFn: mockFetch,
            },
            new Date(Date.UTC(2026, 10, 18))
        );

        assert.ok(res);
        assert.strictEqual(res.providerId, 'bmo');
        assert.strictEqual(res.asOfDate, '2026-11-17');
        // KY Cayman domicile is excluded from sovereign country weights -> becomes 20% + 10% cash = 30% residual
        assert.deepStrictEqual(res.countryAllocations, [
            { Taiwan: 0.4 },
            { 'South Korea': 0.3 },
        ]);
        assert.deepStrictEqual(res.sectorAllocations, [
            { Technology: 0.7 },
            { 'Communication Services': 0.2 },
        ]);
    });

    test('recursively resolves BMO fund-of-funds (ZBAL.TO) across underlying CA ISINs', async () => {
        const zbalXlsx = buildBmoXlsxBuffer([
            ['Name', 'ISIN', 'Asset Class', 'Sector', 'Weight (%)', 'Base Market Value'],
            // BMO marks wrapper ETFs as Sector=Financials & ISIN=CA... in ZBAL! Recursive resolution fixes both.
            ['BMO S&P 500 Index ETF', 'CA05575T1003', 'Equities', 'Financials', 30, 300000],
            ['BMO S&P/TSX Capped Composite Index ETF', 'CA05574G1090', 'Equities', 'Financials', 20, 200000],
            ['BMO MSCI EAFE Index ETF', 'CA05579E1097', 'Equities', 'Financials', 10, 100000],
            ['BMO Discount Bond Index ETF', 'CA05590X1024', 'Fixed Income', 'Financials', 40, 400000],
        ]);
        const zspXlsx = buildBmoXlsxBuffer([
            ['Name', 'ISIN', 'Asset Class', 'Sector', 'Weight (%)'],
            ['APPLE INC', 'US0378331005', 'Equities', 'Information Technology', 60],
            ['ELI LILLY', 'US5324571083', 'Equities', 'Health Care', 40],
        ]);
        const zcnXlsx = buildBmoXlsxBuffer([
            ['Name', 'ISIN', 'Asset Class', 'Sector', 'Weight (%)'],
            ['ROYAL BANK OF CANADA', 'CA7800871021', 'Equities', 'Financials', 100],
        ]);
        const zeaXlsx = buildBmoXlsxBuffer([
            ['Name', 'ISIN', 'Asset Class', 'Sector', 'Weight (%)'],
            ['ASML HOLDING NV', 'NL0010273215', 'Equities', 'Information Technology', 100],
        ]);
        const zdbXlsx = buildBmoXlsxBuffer([
            ['Name', 'ISIN', 'Asset Class', 'Sector', 'Weight (%)'],
            ['CANADA HOUSING TRUST', 'CA13509PFE84', 'Fixed Income', 'Government', 100],
        ]);

        const map: Record<string, Buffer> = {
            Holdings_Extract_en_US_ZBAL_20261118: zbalXlsx,
            Holdings_Extract_en_US_ZSP_20261118: zspXlsx,
            Holdings_Extract_en_US_ZCN_20261118: zcnXlsx,
            Holdings_Extract_en_US_ZEA_20261118: zeaXlsx,
            Holdings_Extract_en_US_ZDB_20261118: zdbXlsx,
        };

        const mockFetch: typeof fetch = async (input) => {
            const url = String(input);
            for (const [key, buf] of Object.entries(map)) {
                if (url.includes(key)) return binaryResponse(buf);
            }
            return new Response('Not Found', { status: 404 });
        };

        const res = await fetchBmoAllocationsWithDate(
            {
                symbol: 'ZBAL.TO',
                quoteType: 'ETF',
                fundName: 'BMO Balanced ETF',
                fetchFn: mockFetch,
            },
            new Date(Date.UTC(2026, 10, 18))
        );

        assert.ok(res);
        // Canada = 0.20 (ZCN) + 0.40 (ZDB) = 0.60; US = 0.30; Netherlands = 0.10
        assert.deepStrictEqual(res.countryAllocations, [
            { Canada: 0.6 },
            { 'United States': 0.3 },
            { Netherlands: 0.1 },
        ]);
        // Technology = 0.30*0.60 + 0.10*1.00 = 0.28; Financials = 0.20 (NOT inflated by wrapper labels!); Healthcare = 0.12
        assert.deepStrictEqual(res.sectorAllocations, [
            { Technology: 0.28 },
            { 'Financial Services': 0.2 },
            { Healthcare: 0.12 },
        ]);
    });

    test('handles ZUAG-F variant fallback, omits fixed-income sectors, and fails soft on ZGLD bullion ETF', async () => {
        const zuagXlsx = buildBmoXlsxBuffer([
            ['Name', 'ISIN', 'Asset Class', 'Sector', 'Weight (%)'],
            ['US TREASURY N/B', 'US912828ZT04', 'Fixed Income', 'Government', 100],
        ]);
        const zgldXlsx = buildBmoXlsxBuffer([
            ['Name', 'ISIN', 'Asset Class', 'Sector', 'Weight (%)'],
            ['SPOT PHYSICAL GOLD', '', 'Commodities', '-', 99.8],
            ['CASH', '', 'Cash', '-', 0.2],
        ]);

        const mockFetch: typeof fetch = async (input) => {
            const url = String(input);
            if (url.includes('Holdings_Extract_en_US_ZUAG.F_20261116.xlsx')) {
                return binaryResponse(zuagXlsx);
            }
            if (url.includes('Holdings_Extract_en_US_ZGLD_20261118.xlsx')) {
                return binaryResponse(zgldXlsx);
            }
            return new Response('Not Found', { status: 404 });
        };

        const zuagRes = await fetchBmoAllocationsWithDate(
            {
                symbol: 'ZUAG-F.TO',
                quoteType: 'ETF',
                fundName: 'BMO US Aggregate Bond Index ETF (CAD Units)',
                fetchFn: mockFetch,
            },
            new Date(Date.UTC(2026, 10, 18))
        );
        assert.ok(zuagRes);
        assert.strictEqual(zuagRes.productId, 'ZUAG.F');
        assert.deepStrictEqual(zuagRes.countryAllocations, [{ 'United States': 1 }]);
        assert.strictEqual(zuagRes.sectorAllocations, undefined);

        const zgldRes = await fetchBmoAllocationsWithDate(
            {
                symbol: 'ZGLD.TO',
                quoteType: 'ETF',
                fundName: 'BMO Gold Bullion ETF',
                fetchFn: mockFetch,
            },
            new Date(Date.UTC(2026, 10, 18))
        );
        assert.strictEqual(zgldRes, null);

        assert.deepStrictEqual(parseBmoHoldingsSheet([['Empty']]).holdings, []);
    });
});
