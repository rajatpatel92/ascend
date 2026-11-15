import { NextResponse } from 'next/server';
import NextAuth from 'next-auth';
import { authConfig } from './auth.config';

const { auth } = NextAuth(authConfig);

export default auth((req) => {
    // 1. Get the permitted domains from the environment variable
    const allowedDomainsString = process.env.ALLOWED_DOMAINS || '';

    // Split the comma-separated string into an array and clean up any whitespace
    const allowedDomains = allowedDomainsString
        .split(',')
        .map(domain => domain.trim())
        .filter(domain => domain.length > 0);

    // 2. Extract the Host header from the incoming request
    const hostHeader = req.headers.get('host') || '';

    // Strip out the port to compare just the domain name
    const hostname = hostHeader.split(':')[0];

    // 3. Security Check: Is the incoming domain in our allowed list?
    if (allowedDomains.length > 0 && !allowedDomains.includes(hostname)) {
        console.warn(`[Security] Blocked access attempt from unauthorized domain: ${hostname}`);
        return new NextResponse(`Forbidden: Unauthorized Domain (${hostname})`, { status: 403 });
    }

    // 4. Let the request pass through to NextAuth or the application
    return NextResponse.next();
});

export const config = {
    // https://nextjs.org/docs/app/building-your-application/routing/middleware#matcher
    matcher: ['/((?!api|_next/static|_next/image|favicon.ico|favicon.svg|favicon.png|icon.png|icon-192.png|logo.png|logo.jpg|sw.js|workbox-.*|manifest.json).*)'],
};

