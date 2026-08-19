import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts', 'src/index.ts'],
  format: ['esm'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'node20',
  // The shebang tsup would otherwise strip, so `npx jarvisclaw` is executable.
  banner: { js: '#!/usr/bin/env node' },
  external: ['@jarvisclaw/sdk', 'viem', '@solana/web3.js'],
})
