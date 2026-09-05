import * as fs from 'fs';
import * as path from 'path';

import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * The directory `scripts/bundle-scanner.js` writes, and the directory the CDK asset
 * is taken from.
 */
export const bundleDirectory = path.join(__dirname, '..', 'build', 'scan-lambda');

/**
 * scannerCode resolves the built scanner bundle into a CDK asset.
 *
 * `cdk.json` runs the bundle script before the app on every CDK command, so this
 * normally finds a fresh build. It checks anyway and says which command to run,
 * because someone invoking the app directly - through `ts-node`, or through a test
 * that forgot to inject its own code - would otherwise get a bare missing-directory
 * error from the asset staging code.
 */
export function scannerCode(): lambda.Code {
  const entrypoint = path.join(bundleDirectory, 'bootstrap');
  if (!fs.existsSync(entrypoint)) {
    throw new Error(
      `the scanner bundle is missing from ${bundleDirectory}: run "npm run bundle" in infra/`,
    );
  }
  return lambda.Code.fromAsset(bundleDirectory);
}
