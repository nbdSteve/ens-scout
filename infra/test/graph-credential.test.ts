import { Template } from 'aws-cdk-lib/assertions';

import { goSource, goStringConstants, requireConstant, synth, testConfig, testSecretName } from './helpers';

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

  test('reaches the function under the name internal/scanner reads', () => {
    const constants = goStringConstants(goSource('internal/scanner/scanner.go'));
    const variable = requireConstant(constants, 'EnvAPIKey');
    expect(environmentVariables(template)).toHaveProperty(variable);
  });

  test('is a deploy-time reference, not a value in the template', () => {
    // `{{resolve:secretsmanager:...}}` is substituted by CloudFormation during the
    // deployment, so what the template holds is the secret's address. The assertion
    // is on the rendered text because that is what an operator, a reviewer, and the
    // console all see.
    const rendered = JSON.stringify(environmentVariables(template).THEGRAPH_API_KEY);
    expect(rendered).toContain('{{resolve:secretsmanager:');
    expect(rendered).toContain(testSecretName);
    expect(rendered).toContain(`SecretString:${testConfig.graphApiKeySecretField}`);
  });

  test('is not stored by this stack, only referenced', () => {
    // Creating the secret here would put this stack in a position to overwrite the
    // credential, and a generated one would be a credential The Graph never issued.
    template.resourceCountIs('AWS::SecretsManager::Secret', 0);
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

  test('resolves in exactly one place in the whole template', () => {
    // A second reference is a second place the credential is materialized, and the
    // usual second place is a description, a tag, or an alarm text an operator
    // forwards. Counting is what makes this catch a field a later edit adds, which
    // naming the fields to check could not.
    const occurrences = JSON.stringify(template.toJSON()).split('{{resolve:').length - 1;
    expect(occurrences).toBe(1);
  });
});

function environmentVariables(template: Template): Record<string, unknown> {
  const functions = template.findResources('AWS::Lambda::Function');
  const properties = Object.values(functions)[0].Properties as {
    Environment?: { Variables?: Record<string, unknown> };
  };
  return properties.Environment?.Variables ?? {};
}
