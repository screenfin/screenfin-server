import config from '../eslint.config.js';

// Enforce the relay's complete outbound Jellyfin boundary. Identity validation (`/Users/Me`) and
// item visibility (`/Items?userId=…&ids=…`) both use the *user's* own token, so widening this is
// where a service credential or a client-supplied address would first appear. The third entry reads
// the server `Id` from `/System/Info/Public` — credential-free, on the same configured base — so
// discovery (PROTOCOL.md § 2.1) can say which Jellyfin this relay belongs to.
const outboundRequestMessage =
  'Only src/identity.ts, src/visibility.ts and src/jellyfinBinding.ts may make outbound HTTP ' +
  'requests to the configured Jellyfin server.';

export default [
  ...config,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/identity.ts', 'src/visibility.ts', 'src/jellyfinBinding.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: outboundRequestMessage,
        },
      ],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:http', message: outboundRequestMessage },
            { name: 'node:https', message: outboundRequestMessage },
            { name: 'http', message: outboundRequestMessage },
            { name: 'https', message: outboundRequestMessage },
            { name: 'undici', message: outboundRequestMessage },
            { name: 'axios', message: outboundRequestMessage },
            { name: 'node-fetch', message: outboundRequestMessage },
            { name: 'got', message: outboundRequestMessage },
          ],
        },
      ],
    },
  },
];
