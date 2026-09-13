import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { placeholderAccount } from '../lib/config';

// Plain CommonJS, required rather than imported, like scripts/bundle-scanner.js.
const render = require('../scripts/render-iam');

/**
 * The render script is the only path from a committed template to an applied IAM
 * document, and nothing detects drift between what it produces and what a role really
 * carries, so these are the properties an operator's diff rests on.
 *
 * `iam/README.md` describes the arrangement and `test/deployment.test.ts` asserts the
 * policy semantics of the rendered documents. This file asserts the rendering itself.
 */

const values: Record<string, string> = render.exampleValues();

describe('the example values', () => {
  test('supply every placeholder the templates use, and nothing else', () => {
    // `--example` has to render every document, or the example set is not a worked
    // example of anything.
    expect(() => render.renderAll(values)).not.toThrow();
  });

  test('name an account nobody owns', () => {
    // The same placeholder cdk.json commits, so a reviewer can read a whole rendered
    // policy and a synthesized template and see one account in both.
    expect(values.ACCOUNT_ID).toBe(placeholderAccount);
  });
});

describe('rendering one document', () => {
  const template = render.readTemplate('github-deploy-role-policy');

  test('substitutes every placeholder', () => {
    const document = render.renderIamDocument(template, values);
    expect(render.placeholdersIn(template).size).toBeGreaterThan(0);
    expect(render.placeholdersIn(document).size).toBe(0);
    expect(document).toContain(values.CLOUDFORMATION_EXECUTION_ROLE_NAME);
  });

  test('is deterministic, so a rendered document can be diffed against the applied one', () => {
    expect(render.renderIamDocument(template, values)).toBe(
      render.renderIamDocument(template, values),
    );
  });

  test('produces canonical JSON with a trailing newline', () => {
    const document: string = render.renderIamDocument(template, values);
    expect(document.endsWith('\n')).toBe(true);
    expect(document).toBe(`${JSON.stringify(JSON.parse(document), null, 2)}\n`);
  });

  test('refuses a placeholder it does not know', () => {
    // A template may not introduce one silently: an unsubstituted `${...}` in a
    // Resource is an ARN that matches nothing, so every call is denied at the
    // deployment rather than at the moment the placeholder was added.
    expect(() => render.renderIamDocument('{"A": "${NOT_A_PLACEHOLDER}"}', values)).toThrow(
      'NOT_A_PLACEHOLDER',
    );
  });

  test('refuses a placeholder nothing supplied a value for', () => {
    expect(() => render.renderIamDocument(template, {})).toThrow(/no value supplied/);
  });

  test('refuses a value that is not shaped like the thing it names', () => {
    for (const account of ['12345678901', '1234567890123', '12345678901a', '']) {
      expect(() =>
        render.renderIamDocument(template, { ...values, ACCOUNT_ID: account }),
      ).toThrow(/ACCOUNT_ID/);
    }
    expect(() =>
      render.renderIamDocument(template, {
        ...values,
        CLOUDFORMATION_EXECUTION_ROLE_NAME: 'not a role name',
      }),
    ).toThrow(/CLOUDFORMATION_EXECUTION_ROLE_NAME/);
  });

  test('names only the placeholder in a refusal, never the value', () => {
    // This is the property that makes it safe to render the real documents: the run
    // that fills in the account is exactly the run whose output must not carry it.
    const secret = '123456789012';
    let message = '';
    try {
      render.renderIamDocument(template, {
        ...values,
        ACCOUNT_ID: secret,
        CLOUDFORMATION_EXECUTION_ROLE_NAME: 'not a role name',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('CLOUDFORMATION_EXECUTION_ROLE_NAME');
    expect(message).not.toContain('not a role name');
    expect(message).not.toContain(secret);
  });
});

describe('rendering every document', () => {
  test('refuses a supplied value no template uses', () => {
    // A value nothing substitutes is a placeholder that was renamed in one place and
    // not the other, and the document it was meant for would be applied with the old
    // name still in it.
    expect(() => render.renderAll({ ...values, REGION: 'ap-southeast-2' })).toThrow('REGION');
  });

  test('renders one document per template', () => {
    const rendered: Map<string, string> = render.renderAll(values);
    expect([...rendered.keys()]).toEqual(render.templateNames());
    for (const document of rendered.values()) {
      expect(() => JSON.parse(document)).not.toThrow();
    }
  });
});

describe('the command line', () => {
  test('writes outside the template directory, and refuses to write into it', () => {
    // Rendering over the templates would put the account back in the repository, which
    // is the one thing the arrangement exists to prevent.
    expect(render.parseArgv(['--example']).outDir).toBe(render.defaultOutDir);
    expect(render.defaultOutDir.startsWith(render.iamDir)).toBe(true);
    expect(render.defaultOutDir).not.toBe(render.iamDir);
    expect(() => render.parseArgv(['--example', '--out-dir', render.iamDir])).toThrow();
  });

  test('maps each flag to the placeholder it fills', () => {
    const options = render.parseArgv([
      '--account-id',
      placeholderAccount,
      '--execution-role-name',
      'SomeRole',
    ]);
    expect(options.values).toEqual({
      ACCOUNT_ID: placeholderAccount,
      CLOUDFORMATION_EXECUTION_ROLE_NAME: 'SomeRole',
    });
    expect(options.example).toBe(false);
  });

  test('refuses an argument it does not know, and a flag with no value', () => {
    expect(() => render.parseArgv(['--account', placeholderAccount])).toThrow(/unknown argument/);
    expect(() => render.parseArgv(['--account-id'])).toThrow(/takes a value/);
  });

  test('refuses --example beside a value of its own', () => {
    // Two sources for one placeholder is a document whose account nobody chose.
    expect(() =>
      render.parseArgv(['--example', '--account-id', placeholderAccount]),
    ).toThrow(/--example/);
  });
});

describe('the rendered output directory', () => {
  test('is ignored by git, so no rendered document can be committed', () => {
    const ignored = fs
      .readFileSync(path.join(__dirname, '..', '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.trim());
    expect(ignored).toContain(`${path.relative(path.join(__dirname, '..'), render.defaultOutDir)}/`);
  });

  test('receives one file per template, named as the document rather than the template', () => {
    // The name an operator diffs against is the document's, so the `.template` part is
    // dropped: `iam/rendered/<name>.json` beside what `aws iam get-role-policy` returns.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ens-scout-iam-'));
    try {
      for (const [name, document] of render.renderAll(values) as Map<string, string>) {
        fs.writeFileSync(path.join(outDir, `${name}.json`), document);
      }
      expect(fs.readdirSync(outDir).sort()).toEqual(
        render.templateNames().map((name: string) => `${name}.json`),
      );
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });
});
