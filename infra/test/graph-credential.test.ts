import { Template } from 'aws-cdk-lib/assertions';

import {
  environmentVariables,
  goSource,
  goStringConstants,
  requireConstant,
  synth,
  testConfig,
  testSecretName,
} from './helpers';

/**
 * These assertions are the infrastructure half of the repository's standing rule
 * that `THEGRAPH_API_KEY` never appears in source, fixtures, output, or an error.
 * A synthesized template is committed nowhere, but it is written to `cdk.out`,
 * printed by `cdk synth`, and uploaded to the CloudFormation console, so a
 * credential resolved at synthesis time would be exposed in all three.
 */
describe('the Graph API credential', () => {
  let template: Template;

  beforeAll(() => {
    template = synth().template;
  });

  test('reaches both Graph clients under the name internal/scanner reads', () => {
    const constants = goStringConstants(goSource('internal/scanner/scanner.go'));
    const variable = requireConstant(constants, 'EnvAPIKey');
    expect(environmentVariables(template)).toHaveProperty(variable);
    expect(environmentVariables(template, 'ENS_API_ORIGIN_SECRET')).toHaveProperty(variable);
  });

  test('is a deploy-time reference, not a value in the template', () => {
    // `{{resolve:secretsmanager:...}}` is substituted by CloudFormation during the
    // deployment, so what the template holds is the secret's address. The assertion
    // is on the rendered text because that is what an operator, a reviewer, and the
    // console all see.
    for (const variables of [
      environmentVariables(template),
      environmentVariables(template, 'ENS_API_ORIGIN_SECRET'),
    ]) {
      const rendered = JSON.stringify(variables.THEGRAPH_API_KEY);
      expect(rendered).toContain('{{resolve:secretsmanager:');
      expect(rendered).toContain(testSecretName);
      expect(rendered).toContain(`SecretString:${testConfig.graphApiKeySecretField}`);
    }
  });

  test('the Graph credential is not stored by this stack, only referenced', () => {
    // The two generated secrets belong to the check limiter and the private
    // CloudFront origin. Neither is named as or usable as a Graph credential.
    template.resourceCountIs('AWS::SecretsManager::Secret', 2);
    const secrets = JSON.stringify(template.findResources('AWS::SecretsManager::Secret'));
    expect(secrets).not.toContain(testSecretName);
    template.resourceCountIs('AWS::SecretsManager::ResourcePolicy', 0);
    template.resourceCountIs('AWS::SecretsManager::RotationSchedule', 0);
  });

  test('is absent from every output', () => {
    // The secret's name is not secret and is published so an operator can find it.
    // The resolved value, and the dynamic reference that would resolve it in a
    // second place, must not be.
    const outputs = JSON.stringify(template.toJSON().Outputs ?? {});
    expect(outputs).toContain(testSecretName);
    expect(outputs).not.toContain('{{resolve:');
  });

  test('resolves exactly in the two functions that query the Graph', () => {
    const resources = JSON.stringify(template.toJSON().Resources ?? {});
    expect(resources.split(testSecretName).length - 1).toBe(2);
  });
});
