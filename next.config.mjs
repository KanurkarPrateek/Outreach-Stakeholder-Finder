/** @type {import('next').NextConfig} */
const nextConfig = {
  // Pin the workspace root (multiple lockfiles exist on this machine).
  turbopack: { root: import.meta.dirname },
};

export default nextConfig;
