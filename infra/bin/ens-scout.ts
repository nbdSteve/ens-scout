#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';

import { resolveConfig } from '../lib/config';
import { EnsScoutStack } from '../lib/ens-scout-stack';
import { scannerCode } from '../lib/scanner-bundle';

const app = new cdk.App();
const config = resolveConfig(app);

// The account and region come from context, not from the shell. An environment
// resolved from ambient credentials would make `cdk synth` and `cdk diff` produce a
// different template depending on who ran them, and would let a stack meant for one
// account be deployed into another by exporting a different profile.
new EnsScoutStack(app, `EnsScout-${config.environmentName}`, {
  config,
  scannerCode: scannerCode(),
  env: { account: config.account, region: config.region },
  description: `ENS Scout scheduled snapshot publisher (${config.environmentName})`,
});
