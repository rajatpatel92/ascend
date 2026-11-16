import withPWAInit from "@ducanh2912/next-pwa";
import type { NextConfig } from "next";

const withPWA = withPWAInit({
  dest: "public",
  disable: false,
  extendDefaultRuntimeCaching: true,
  workboxOptions: {
    runtimeCaching: [
      {
        urlPattern: ({ sameOrigin, url }: { sameOrigin: boolean; url: URL }) =>
          sameOrigin && url.pathname.startsWith("/api/"),
        handler: "NetworkOnly",
        method: "GET",
        options: {
          cacheName: "apis",
        },
      },
      {
        urlPattern: ({ sameOrigin, url }: { sameOrigin: boolean; url: URL }) =>
          sameOrigin && url.pathname.startsWith("/api/"),
        handler: "NetworkOnly",
        method: "POST",
        options: {
          cacheName: "apis-post",
        },
      },
      {
        urlPattern: ({ sameOrigin, url }: { sameOrigin: boolean; url: URL }) =>
          sameOrigin && url.pathname.startsWith("/api/"),
        handler: "NetworkOnly",
        method: "PUT",
        options: {
          cacheName: "apis-put",
        },
      },
      {
        urlPattern: ({ sameOrigin, url }: { sameOrigin: boolean; url: URL }) =>
          sameOrigin && url.pathname.startsWith("/api/"),
        handler: "NetworkOnly",
        method: "DELETE",
        options: {
          cacheName: "apis-delete",
        },
      },
      {
        urlPattern: ({ sameOrigin, url }: { sameOrigin: boolean; url: URL }) =>
          sameOrigin && url.pathname.startsWith("/api/"),
        handler: "NetworkOnly",
        method: "PATCH",
        options: {
          cacheName: "apis-patch",
        },
      },
    ],
  },
});

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  output: 'standalone',
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default withPWA(nextConfig);
