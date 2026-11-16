import * as cdk from 'aws-cdk-lib';

import { Config } from './config';

/**
 * How this application is deployed, kept in one module because the values
 * below have to agree with an IAM policy that lives outside CDK.
 *
 * `infra/iam/` holds the role and policy documents the deployment uses and
 * `docs/deployment.md` explains them. `test/deployment.test.ts` ties them to this
 * module, so a change here that the documents do not follow fails a test rather
 * than a deployment.
 */

/**
 * bootstrapQualifier is the CDK bootstrap qualifier this application deploys
 * against.
 *
 * It is the CDK default and the account is already bootstrapped with it. It is named
 * here rather than left implicit because the deployment role's S3 grant is written
 * against the bucket the qualifier produces: changing this value without changing
 * that grant would leave asset publishing denied.
 */
export const bootstrapQualifier = 'hnb659fds';

/**
 * assetBucketName is the bootstrap bucket assets are published to.
 *
 * The synthesizer below derives the same name from the qualifier, so this is what
 * the deployment role has to be able to write to.
 */
export function assetBucketName(account: string, region: string): string {
  return `cdk-${bootstrapQualifier}-assets-${account}-${region}`;
}

/**
 * deploymentSynthesizer deploys with the caller's own credentials and publishes
 * assets to the bootstrap bucket directly.
 *
 * The default synthesizer makes every deployment assume `cdk-hnb659fds-deploy-role`,
 * which may pass `cdk-hnb659fds-cfn-exec-role`, and that role carries
 * AdministratorAccess and can be passed to any stack. An identity permitted to
 * assume the deploy role is therefore an account administrator by another name,
 * whatever its own policy says, and the bootstrap deploy role's `iam:PassRole` is
 * restricted to that one admin-capable role, so a narrower execution role cannot be
 * substituted through it.
 *
 * Removing that hop is what makes least privilege reachable here: the GitHub OIDC
 * role holds the CloudFormation and asset permissions it actually needs, and passes
 * one execution role scoped to this stack's own resources.
 *
 * The bootstrap stack is still required. The qualifier names the bucket assets are
 * published to and the SSM parameter that records the bootstrap version; only the
 * four bootstrap roles go unused.
 */
export function deploymentSynthesizer(): cdk.IStackSynthesizer {
  // The assertion is an upstream typing wart rather than a widening. IStackSynthesizer
  // declares `bootstrapQualifier?: string`, every concrete synthesizer in aws-cdk-lib
  // returns `string | undefined` from it, and `exactOptionalPropertyTypes` refuses
  // that. Narrowing to the interface here is the smallest way to say so, and it stays
  // a compile error if the interface itself changes.
  return new cdk.CliCredentialsStackSynthesizer({
    qualifier: bootstrapQualifier,
  }) as cdk.IStackSynthesizer;
}

/**
 * permissionsBoundaryName is the customer-managed policy every IAM role in the stack
 * carries as its permissions boundary.
 *
 * The policy is configuration in the account rather than a resource in the stack, for
 * the reason the deployment roles are: the stack cannot create the thing that limits
 * what the stack may create. `infra/iam/permissions-boundary-policy.template.json` is
 * its document, and the CloudFormation execution role's policy allows the IAM calls
 * that shape a role only when the request names this policy's ARN.
 *
 * The name carries the stack name, so it stays inside the `EnsScout-prod-` prefix the
 * rest of the account-side grants use. `test/deployment.test.ts` ties it to the
 * committed templates.
 */
export function permissionsBoundaryName(environmentName: string): string {
  return `EnsScout-${environmentName}-PermissionsBoundary`;
}

/**
 * stackPermissionsBoundary is the boundary every role the stack creates is given.
 *
 * CDK applies it to every `AWS::IAM::Role` in the stack, including one a construct
 * creates on its own behalf, which is why it is a stack property rather than a prop
 * on each role: a role added later cannot forget it.
 */
export function stackPermissionsBoundary(environmentName: string): cdk.PermissionsBoundary {
  return cdk.PermissionsBoundary.fromName(permissionsBoundaryName(environmentName));
}

/**
 * deploymentParameterNames are the CloudFormation parameters that carry the two
 * deployment identifiers when `ens-scout:deferDeploymentIdentifiers` is true.
 *
 * They are the names `cdk deploy --parameters` addresses, so the workflow and
 * `test/deployment.test.ts` both read them from here.
 */
export const deploymentParameterNames = {
  siteHostedZoneId: 'SiteHostedZoneId',
  siteCertificateArn: 'SiteCertificateArn',
} as const;

/**
 * DeploymentIdentifiers are the two values the stack cannot take from a committed
 * file: the existing public hosted zone and the existing viewer certificate.
 */
export interface DeploymentIdentifiers {
  readonly hostedZoneId: string;
  readonly certificateArn: string;
}

/**
 * deploymentIdentifiers returns the hosted-zone ID and certificate ARN the stack
 * uses.
 *
 * Normally they are the context values. With `deferDeploymentIdentifiers` they are
 * two required CloudFormation parameters instead, and the stack is also left
 * environment-agnostic (see `bin/ens-scout.ts`), so the assembly names no account, no
 * zone, and no certificate.
 *
 * That is the only way the production build job can stay free of the `production`
 * environment's secrets. Environment secrets reach only a job that declares the
 * environment, and that job is the one holding the OIDC token, which must not run
 * third-party build code. So the build synthesizes an assembly with holes in it, and
 * the deploy job fills them through `--parameters` from its own secrets.
 *
 * The parameters have no default, so a deployment that forgets them fails in
 * CloudFormation rather than deploying at a placeholder. The patterns are the same
 * shapes `lib/config.ts` demands of the context values; the account match the context
 * path checks is the deploy job's own validation step, because a CloudFormation
 * parameter pattern cannot refer to another value. NoEcho keeps the values out of the
 * console and out of `DescribeStacks`.
 */
export function deploymentIdentifiers(scope: cdk.Stack, config: Config): DeploymentIdentifiers {
  if (!config.deferDeploymentIdentifiers) {
    return {
      hostedZoneId: config.siteHostedZoneId,
      certificateArn: config.siteCertificateArn,
    };
  }
  const hostedZoneId = new cdk.CfnParameter(scope, deploymentParameterNames.siteHostedZoneId, {
    type: 'String',
    noEcho: true,
    allowedPattern: '^Z[A-Z0-9]{10,31}$',
    description: 'The existing public Route 53 hosted zone that holds the site records',
  });
  const certificateArn = new cdk.CfnParameter(scope, deploymentParameterNames.siteCertificateArn, {
    type: 'String',
    noEcho: true,
    allowedPattern:
      '^arn:aws:acm:us-east-1:[0-9]{12}:certificate/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    description: 'The existing us-east-1 ACM certificate the distribution serves',
  });
  return {
    hostedZoneId: hostedZoneId.valueAsString,
    certificateArn: certificateArn.valueAsString,
  };
}
