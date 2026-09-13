import * as fs from 'fs';
import * as path from 'path';

import * as lambda from 'aws-cdk-lib/aws-lambda';

/** The reproducible bundle written by scripts/bundle-scanner.js. */
export const apiBundleDirectory = path.join(__dirname, '..', 'build', 'api-lambda');

/** Resolves the production API binary into a CDK asset. */
export function apiCode(): lambda.Code {
  const entrypoint = path.join(apiBundleDirectory, 'bootstrap');
  if (!fs.existsSync(entrypoint)) {
    throw new Error(
      `the API bundle is missing from ${apiBundleDirectory}: run "npm run bundle" in infra/`,
    );
  }
  return lambda.Code.fromAsset(apiBundleDirectory);
}
