import type { NextConfig } from "next";
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  serverExternalPackages: [
    'argon2',
    '@prisma/client',
    'sharp',
    'z-ai-web-dev-sdk',
  ],
  allowedDevOrigins: [
    '*.space-z.ai',
  ],
  experimental: {
    optimizePackageImports: ['lucide-react', 'date-fns'],
  },
};

export default withNextIntl(nextConfig);
