import * as vm from 'vm';

import { spaRewriteCode } from '../lib/spa';

type CloudFrontHandler = (event: { request: { uri: string } }) => { uri: string };

function rewrite(uri: string): string {
  const context: { handler?: CloudFrontHandler } = {};
  vm.runInNewContext(`${spaRewriteCode}\nthis.handler = handler;`, context);
  return context.handler!({ request: { uri } }).uri;
}

describe('the SPA viewer-request rewrite', () => {
  test.each(['/', '/names/zap', '/names/'])('rewrites application route %s', (path) => {
    expect(rewrite(path)).toBe('/index.html');
  });

  test.each(['/assets/missing-deadbeef.js', '/favicon.svg', '/robots.txt'])(
    'does not turn missing file %s into HTML',
    (path) => {
      expect(rewrite(path)).toBe(path);
    },
  );

  test.each(['/api/check', '/api/snapshot', '/health'])(
    'never rewrites API path %s',
    (path) => {
      expect(rewrite(path)).toBe(path);
    },
  );
});
