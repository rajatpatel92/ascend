import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { deflateRawSync } from 'node:zlib';
import { calculateLookThrough } from '../look-through.ts';
import { prepareCountryMapData } from '../world-map.ts';
import { resetHostCircuitBreakersForTests } from './http.ts';
import { REGISTERED_ISSUER_ADAPTERS, resolveIssuerAllocations } from './index.ts';

function buildMinimalXlsx(rows: Array<Array<string | number>>): Buffer {
    const rowXml = rows
        .map((cells, rIdx) => {
            const cellXml = cells
                .map((cell, cIdx) => {
                    const col = String.fromCharCode(65 + cIdx);
                    const ref = `${col}${rIdx + 1}`;
                    return typeof cell === 'number'
                        ? `<c r="${ref}"><v>${cell}</v></c>`
                        : `<c r="${ref}" t="inlineStr"><is><t>${cell}</t></is></c>`;
                })
                .join('');
            return `<row r="${rIdx + 1}">${cellXml}</row>`;
        })
        .join('');

    const files = [
        {
            name: 'xl/workbook.xml',
            content: Buffer.from(
                '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Holdings" sheetId="1" r:id="rId1"/></sheets></workbook>',
                'utf8'
            ),
        },
        {
            name: 'xl/_rels/workbook.xml.rels',
            content: Buffer.from(
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
                'utf8'
            ),
        },
        {
            name: 'xl/worksheets/sheet1.xml',
            content: Buffer.from(
                `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`,
                'utf8'
            ),
        },
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

describe('REGISTERED_ISSUER_ADAPTERS multi-issuer integration', () => {
    beforeEach(() => {
        resetHostCircuitBreakersForTests();
    });

    test('exports all four issuer adapters and dispatches Vanguard, BMO, TD into look-through and world map', async () => {
        assert.deepStrictEqual(
            REGISTERED_ISSUER_ADAPTERS.map((a) => a.id),
            ['ishares', 'vanguard', 'bmo', 'td']
        );

        const mockZea = buildMinimalXlsx([
            ['Name', 'ISIN', 'Asset Class', 'Sector', 'Weight (%)'],
            ['NOVO NORDISK', 'DK0062498333', 'Equities', 'Health Care', 50],
            ['TOYOTA MOTOR', 'JP3633400001', 'Equities', 'Consumer Discretionary', 50],
        ]);

        const mockFetch: typeof fetch = async (input) => {
            const url = String(input);
            if (url === 'https://www.vanguard.ca/gpx/graphql') {
                return new Response(
                    JSON.stringify({
                        data: {
                            funds: [
                                {
                                    profile: { assetClassificationLevel1: 'Equity' },
                                    marketAllocation: [{ countryCode: 'US', fundMktPercent: 100 }],
                                    sectorDiversification: [{ sectorName: 'Technology', fundPercent: 100 }],
                                },
                            ],
                        },
                    }),
                    { status: 200 }
                );
            }
            if (url.includes('Holdings_Extract_en_US_ZEA_')) {
                return new Response(new Uint8Array(mockZea), { status: 200 });
            }
            if (url.includes('fundcard?fundId=7113')) {
                return new Response(
                    '<h3>Fund Geography</h3><div>United States 90%</div><div>Japan 10%</div>',
                    { status: 200 }
                );
            }
            return new Response('Not Found', { status: 404 });
        };

        const [vfv, zea, tec, quu] = await Promise.all([
            resolveIssuerAllocations({
                symbol: 'VFV.TO',
                quoteType: 'ETF',
                fundName: 'Vanguard S&P 500 Index ETF',
                fetchFn: mockFetch,
            }),
            resolveIssuerAllocations({
                symbol: 'ZEA.TO',
                quoteType: 'ETF',
                fundName: 'BMO MSCI EAFE Index ETF',
                fetchFn: mockFetch,
            }),
            resolveIssuerAllocations({
                symbol: 'TEC.TO',
                quoteType: 'ETF',
                fundName: 'TD Global Technology Leaders Index ETF',
                fetchFn: mockFetch,
            }),
            resolveIssuerAllocations({
                symbol: 'QUU.TO',
                quoteType: 'ETF',
                fundName: 'Mackenzie US Large Cap Equity Index ETF',
                fetchFn: mockFetch,
            }),
        ]);

        assert.strictEqual(vfv?.providerId, 'vanguard');
        assert.strictEqual(zea?.providerId, 'bmo');
        assert.strictEqual(tec?.providerId, 'td');
        assert.strictEqual(quu, null);

        const lookThrough = calculateLookThrough([
            {
                symbol: 'VFV.TO',
                type: 'ETF',
                value: 1000,
                countryAllocations: vfv?.countryAllocations,
                sectorAllocations: vfv?.sectorAllocations,
            },
            {
                symbol: 'ZEA.TO',
                type: 'ETF',
                value: 1000,
                countryAllocations: zea?.countryAllocations,
                sectorAllocations: zea?.sectorAllocations,
            },
            {
                symbol: 'TEC.TO',
                type: 'ETF',
                value: 1000,
                countryAllocations: tec?.countryAllocations,
                sectorAllocations: tec?.sectorAllocations,
            },
        ]);

        const countryMap = Object.fromEntries(lookThrough.byCountry.map((c) => [c.name, c.value]));
        assert.strictEqual(countryMap['United States'], 1900);
        assert.strictEqual(countryMap['Japan'], 600);
        assert.strictEqual(countryMap['Denmark'], 500);

        const mapData = prepareCountryMapData(lookThrough.countryDetails);
        assert.strictEqual(mapData.items.length, 3);
        assert.strictEqual(mapData.byCanonicalName.size, 3);
        assert.strictEqual(mapData.totalValue, 3000);
    });
});
