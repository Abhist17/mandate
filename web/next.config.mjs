/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_MONAD_RPC: process.env.NEXT_PUBLIC_MONAD_RPC ?? process.env.MONAD_TESTNET_RPC,
    NEXT_PUBLIC_CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID ?? process.env.MONAD_TESTNET_CHAIN_ID,
    NEXT_PUBLIC_REGISTRY: process.env.MANDATE_REGISTRY_ADDRESS,
    NEXT_PUBLIC_POOL: process.env.CAPITAL_POOL_ADDRESS,
    NEXT_PUBLIC_VENUE: process.env.MINI_PERP_ADDRESS,
    NEXT_PUBLIC_ORACLE: process.env.ORACLE_ADDRESS,
    NEXT_PUBLIC_ASSET: process.env.POOL_ASSET_ADDRESS,
    NEXT_PUBLIC_DEMO_ISSUER: process.env.DEMO_ISSUER_ADDRESS,
    NEXT_PUBLIC_ENVIO_GRAPHQL_URL: process.env.NEXT_PUBLIC_ENVIO_GRAPHQL_URL,
  },
};
export default nextConfig;
