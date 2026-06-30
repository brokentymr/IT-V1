/** @type {import('next').NextConfig} */
const nextConfig = {
  // Server-only deps; keep them external to the server bundle.
  serverExternalPackages: ['pg', 'pg-boss', '@aws-sdk/client-s3'],
};

export default nextConfig;
