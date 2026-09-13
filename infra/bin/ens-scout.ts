#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';

import { apiCode } from '../lib/api-bundle';
import { resolveConfig } from '../lib/config';
import { deploymentSynthesizer } from '../lib/deployment';
import { EnsScoutStack } from '../lib/ens-scout-stack';
import { scannerCode } from '../lib/scanner-bundle';
import { websiteSources } from '../lib/website-bundle';

const app = new cdk.App();
const config = resolveConfig(app);
const website = websiteSources();

// The account and region come from context, not from the shell. An environment
// resolved from ambient credentials would make `cdk synth` and `cdk diff` produce a
// different template depending on who ran them, and would let a stack meant for one
// account be deployed into another by exporting a different profile.
new EnsScoutStack(app, `EnsScout-${config.environmentName}`, {
  config,
  scannerCode: scannerCode(),
  apiCode: apiCode(),
  websiteSource: website.site,
  websiteAssetsSource: website.assets,
  env: { account: config.account, region: config.region },
  description: `ENS Scout scheduled publisher and public website (${config.environmentName})`,
  // Deploy with the caller's own credentials rather than through the CDK bootstrap
  // roles, which are admin-capable. `lib/deployment.ts` explains why, and
  // `docs/deployment.md` records the permission set that replaces them.
  synthesizer: deploymentSynthesizer(),
});
