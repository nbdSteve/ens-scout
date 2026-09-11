import * as cdk from 'aws-cdk-lib';

/**
 * How this application is deployed, kept in one module because the three values
 * below have to agree with an IAM policy that lives outside CDK.
 *
 * `infra/iam/` holds the two role documents the deployment uses and
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
