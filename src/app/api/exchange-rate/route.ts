import { NextResponse } from 'next/server';
import { MarketDataService } from '@/lib/market-data';

export async function POST(request: Request) {
    let body;
    try {
        body = await request.json();
    } catch {
        return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const { from, to } = body;

    console.log(`[ExchangeRateAPI] POST Body: ${JSON.stringify(body)}`);

    // Basic input validation
    const isValidCurrency = (val: any) => typeof val === 'string' && /^[A-Z]{3,5}$/.test(val);

    if (!from || !to) {
        console.log(`[API Error] MISSING PARAMS in BODY. from: '${from}', to: '${to}'`);
        return NextResponse.json({ error: 'Parameters "from" and "to" are required' }, { status: 400 });
    }

    if (!isValidCurrency(from) || !isValidCurrency(to)) {
        console.log(`[API Error] INVALID PARAMS in BODY. from: '${from}', to: '${to}'`);
        return NextResponse.json({ error: 'Invalid currency format. Must be 3-5 uppercase letters.' }, { status: 400 });
    }

    const rate = await MarketDataService.getExchangeRate(from, to);

    if (rate === null) {
        return NextResponse.json({ error: 'Exchange rate not found' }, { status: 404 });
    }

    return NextResponse.json({ from, to, rate });
}
