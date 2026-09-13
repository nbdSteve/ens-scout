import * as fs from 'fs';
import * as path from 'path';

import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

/** The production Vite output the deployment workflow builds before synth. */
export const websiteDirectory = path.join(__dirname, '..', '..', 'web', 'dist');
export const websiteAssetsDirectory = path.join(websiteDirectory, 'assets');

export interface WebsiteSources {
  readonly site: s3deploy.ISource;
  readonly assets: s3deploy.ISource;
}

/**
 * Resolves the tested production web build into CDK assets.
 *
 * The shell and the hashed assets are separate sources because S3 metadata is
 * object metadata: index.html must revalidate, while assets/* is immutable.
 */
export function websiteSources(): WebsiteSources {
  const index = path.join(websiteDirectory, 'index.html');
  if (!fs.existsSync(index)) {
    throw new Error(
      `the production website is missing from ${websiteDirectory}: build web/ with VITE_API_BASE_URL=/ before synth`,
    );
  }
  if (!fs.existsSync(websiteAssetsDirectory)) {
    throw new Error(`the production website has no assets directory at ${websiteAssetsDirectory}`);
  }
  return {
    site: s3deploy.Source.asset(websiteDirectory),
    assets: s3deploy.Source.asset(websiteAssetsDirectory),
  };
}
