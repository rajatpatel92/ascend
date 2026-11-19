import { beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { resetHostCircuitBreakersForTests } from './http.ts';
import { parseTdFundCardHtml, resolveTdTickerCandidates, tdAdapter } from './td.ts';

describe('TD Asset Management Canada direct-issuer adapter', () => {
    beforeEach(() => {
        resetHostCircuitBreakersForTests();
    });

    test('canHandle filters out TD Bank common stock, QUU.TO, and non-CA symbols', () => {
        assert.deepStrictEqual(resolveTdTickerCandidates('TEC.TO'), ['TEC']);
        assert.deepStrictEqual(resolveTdTickerCandidates('TEC.U.TO'), ['TEC.U', 'TEC']);
        assert.strictEqual(resolveTdTickerCandidates('AAPL'), null);

        assert.strictEqual(
            tdAdapter.canHandle({
                symbol: 'TEC.TO',
                quoteType: 'ETF',
                fundName: 'TD Global Technology Leaders Index ETF',
            }),
            true
        );
        assert.strictEqual(
            tdAdapter.canHandle({
                symbol: 'TD.TO',
                quoteType: 'EQUITY',
                fundName: 'The Toronto-Dominion Bank',
            }),
            false
        );
        assert.strictEqual(
            tdAdapter.canHandle({
                symbol: 'QUU.TO',
                quoteType: 'ETF',
                fundName: 'Mackenzie US Large Cap Equity Index ETF',
            }),
            false
        );
        assert.strictEqual(
            tdAdapter.canHandle({
                symbol: 'TEQT.TO',
                quoteType: 'ETF',
            }),
            true
        );
    });

    test('parses SSR Fund Geography and Sector Mix HTML from TEC.TO fundcard', async () => {
        const tecHtml = `
            <html>
                <body>
                    <div class="td-section">
                        <h3>Sector Mix</h3>
                        <p>As of October 31, 2026</p>
                        <ul>
                            <li><span>Technology</span><span>76.80%</span></li>
                            <li><span>Consumer Services</span><span>8.60%</span></li>
                            <li><span>Consumer Goods</span><span>4.40%</span></li>
                            <li><span>Financial Services</span><span>4.10%</span></li>
                            <li><span>Industrial Goods</span><span>2.30%</span></li>
                            <li><span>Industrial Services</span><span>1.60%</span></li>
                            <li><span>Healthcare</span><span>0.80%</span></li>
                            <li><span>Telecommunications</span><span>0.80%</span></li>
                            <li><span>Real Estate</span><span>0.50%</span></li>
                            <li><span>Cash and Cash Equivalent</span><span>0.10%</span></li>
                        </ul>
                    </div>
                    <div class="td-section">
                        <h3>Fund Geography</h3>
                        <div>United States</div><div>89.50%</div>
                        <div>European Union</div><div>5.00%</div>
                        <div>Japan</div><div>3.80%</div>
                        <div>Canada</div><div>0.80%</div>
                        <div>Asia/Pacific Rim</div><div>0.30%</div>
                        <div>Other European</div><div>0.20%</div>
                        <div>Africa and Middle East</div><div>0.20%</div>
                        <div>Latin America</div><div>0.20%</div>
                        <div>Other Asian</div><div>0.10%</div>
                    </div>
                </body>
            </html>
        `;

        const mockFetch: typeof fetch = async (input) => {
            assert.strictEqual(
                String(input),
                'https://www.td.com/ca/en/asset-management/funds/solutions/etfs/fundcard?fundId=7113'
            );
            return new Response(tecHtml, { status: 200, headers: { 'content-type': 'text/html' } });
        };

        const res = await tdAdapter.fetchAllocations({
            symbol: 'TEC.TO',
            quoteType: 'ETF',
            fundName: 'TD Global Technology Leaders Index ETF',
            fetchFn: mockFetch,
        });

        assert.ok(res);
        assert.strictEqual(res.providerId, 'td');
        assert.strictEqual(res.productId, '7113');
        assert.strictEqual(res.asOfDate, 'October 31, 2026');

        const countryMap = Object.assign({}, ...res.countryAllocations);
        assert.ok(Math.abs(countryMap['United States'] - 89.5 / 100.1) < 1e-4);
        assert.strictEqual(countryMap['European Union'] > 0, true);
        assert.strictEqual(countryMap['Japan'] > 0, true);
        assert.strictEqual(countryMap['Canada'] > 0, true);

        const sectorMap = Object.assign({}, ...(res.sectorAllocations ?? []));
        // Industrial Goods (2.3) + Industrial Services (1.6) = Industrials (3.9%)
        assert.ok(Math.abs(sectorMap['Technology'] - 76.8 / 99.9) < 1e-4);
        assert.ok(Math.abs(sectorMap['Industrials'] - 3.9 / 99.9) < 1e-4);
        assert.ok(Math.abs(sectorMap['Consumer Cyclical'] - 8.6 / 99.9) < 1e-4);
        assert.ok(Math.abs(sectorMap['Consumer Defensive'] - 4.4 / 99.9) < 1e-4);
        assert.ok(Math.abs(sectorMap['Communication Services'] - 0.8 / 99.9) < 1e-4);
    });

    test('supports data-* attributes, omits sectors on bond funds, and discovers unmapped fundIds dynamically', async () => {
        const attrHtml = `
            <div
                data-fund-geography='[{"label":"Canada","value":"92.5"},{"label":"United States","value":"7.5"}]'
                data-sector-mix='[{"label":"Government","value":"75.0"},{"label":"Corporate","value":"25.0"}]'
            ></div>
        `;
        const parsedAttr = parseTdFundCardHtml(attrHtml);
        assert.deepStrictEqual(parsedAttr.countryAllocations, [
            { Canada: 0.925 },
            { 'United States': 0.075 },
        ]);
        assert.deepStrictEqual(parsedAttr.sectorAllocations, []);

        const mockFetch: typeof fetch = async (input) => {
            const url = String(input);
            if (url.includes('/bin/fund-filter-data')) {
                return new Response(
                    JSON.stringify({
                        etfs: [{ fundCode: 'TNEW', fundId: '7999' }],
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } }
                );
            }
            if (url.includes('fundId=7999')) {
                return new Response(attrHtml, { status: 200 });
            }
            return new Response('Not Found', { status: 404 });
        };

        const dynamicRes = await tdAdapter.fetchAllocations({
            symbol: 'TNEW.TO',
            quoteType: 'ETF',
            fundName: 'TD New Canadian Bond ETF',
            fetchFn: mockFetch,
        });

        assert.ok(dynamicRes);
        assert.strictEqual(dynamicRes.productId, '7999');
        assert.strictEqual(dynamicRes.sectorAllocations, undefined);
    });

    test('fails soft on HTTP errors or missing Fund Geography table', async () => {
        const diag: string[] = [];
        const res = await tdAdapter.fetchAllocations({
            symbol: 'TEC.TO',
            quoteType: 'ETF',
            fundName: 'TD Global Technology Leaders Index ETF',
            fetchFn: async () => new Response('<html>Maintenance</html>', { status: 503 }),
            onDiagnostic: (m) => diag.push(m),
        });
        assert.strictEqual(res, null);
        assert.ok(diag.some((m) => m.includes('FundCard HTTP 503')));
    });
});
