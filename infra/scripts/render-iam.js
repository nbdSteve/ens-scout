#!/usr/bin/env node
'use strict';

/**
 * Renders the deployment role documents in `iam/` from their templates.
 *
 * The applied documents name the target account, the CloudFormation execution role,
 * and GitHub's immutable repository identity. None belongs in a public repository, so
 * what is committed is a template with an explicit `${PLACEHOLDER}` at every such
 * position. This script is the one path from a template to a document, and
 * `iam/README.md` describes it.
 *
 * Three properties matter, and all three are asserted by `test/iam-render.test.ts`:
 *
 *   1. It is deterministic. The same template and the same values produce the same
 *      bytes, so a rendered document can be diffed against the applied one.
 *   2. It fails closed. An unknown placeholder, a placeholder nothing supplied a
 *      value for, a supplied value no template uses, and a value that is not shaped
 *      like the thing it names are each a refusal rather than a document with a hole
 *      in it - an unsubstituted `${ACCOUNT_ID}` in an applied policy is a resource
 *      ARN that matches nothing, which denies every call at the deployment rather
 *      than at the moment the mistake was made.
 *   3. Nothing it prints or throws contains a supplied value. The run that renders
 *      the real documents is exactly the run whose output must not carry any of
 *      those identifiers, so every message names the placeholder and never its value.
 */

const fs = require('fs');
const path = require('path');

const iamDir = path.join(__dirname, '..', 'iam');
const templateSuffix = '.template.json';
const defaultOutDir = path.join(iamDir, 'rendered');

/**
 * The placeholders this script knows, and the shape each value has to have.
 *
 * A placeholder absent from here is refused rather than passed through, so adding one
 * to a template is a decision made in both places.
 */
const placeholderRules = {
  // Exactly what `lib/config.ts` requires of `ens-scout:account`.
  ACCOUNT_ID: /^[0-9]{12}$/,
  // The character set IAM allows in a role name, and its length limit.
  CLOUDFORMATION_EXECUTION_ROLE_NAME: /^[\w+=,.@-]{1,64}$/,
  // The identifier shape Route 53 returns for a hosted zone.
  ROUTE53_HOSTED_ZONE_ID: /^Z[A-Z0-9]{10,31}$/,
  // The exact prefix shape GitHub reports when immutable repository subjects are
  // enabled. Both identities are canonical positive decimal integers: accepting a
  // sign, zero, a leading zero, or another numeric notation would render a subject
  // GitHub never issues.
  GITHUB_REPOSITORY_IDENTITY: /^nbdSteve@[1-9][0-9]*\/ens-scout@[1-9][0-9]*$/,
};

const placeholderPattern = /\$\{([A-Za-z0-9_]+)\}/g;

/** templateNames lists the committed templates, sorted, so a render is ordered. */
function templateNames() {
  return fs
    .readdirSync(iamDir)
    .filter((entry) => entry.endsWith(templateSuffix))
    .map((entry) => entry.slice(0, -templateSuffix.length))
    .sort();
}

/** readTemplate reads one template by its document name. */
function readTemplate(name) {
  return fs.readFileSync(path.join(iamDir, `${name}${templateSuffix}`), 'utf8');
}

/** placeholdersIn is the set of placeholder names a template text uses. */
function placeholdersIn(text) {
  return new Set([...text.matchAll(placeholderPattern)].map((match) => match[1]));
}

/** exampleValues is the committed synthetic substitution `--example` renders with. */
function exampleValues() {
  return JSON.parse(fs.readFileSync(path.join(iamDir, 'example-values.json'), 'utf8'));
}

/**
 * renderIamDocument substitutes `values` into one template text and returns the
 * canonical JSON for it.
 *
 * Parsing and re-serializing rather than returning the substituted text is what makes
 * the output canonical whatever the template's own whitespace was, and it is also the
 * check that a substituted value cannot produce a document that is no longer JSON.
 */
function renderIamDocument(text, values) {
  for (const placeholder of placeholdersIn(text)) {
    if (!Object.prototype.hasOwnProperty.call(placeholderRules, placeholder)) {
      throw new Error(`unknown placeholder \${${placeholder}}`);
    }
    const value = values[placeholder];
    if (typeof value !== 'string' || value === '') {
      throw new Error(`no value supplied for \${${placeholder}}`);
    }
    if (!placeholderRules[placeholder].test(value)) {
      throw new Error(`the value supplied for \${${placeholder}} is not shaped like one`);
    }
  }
  const substituted = text.replace(placeholderPattern, (match, placeholder) =>
    Object.prototype.hasOwnProperty.call(values, placeholder) ? values[placeholder] : match,
  );
  return `${JSON.stringify(JSON.parse(substituted), null, 2)}\n`;
}

/**
 * renderAll renders every committed template.
 *
 * A supplied value no template uses is refused here rather than in
 * `renderIamDocument`, which sees one document at a time and cannot tell an unused
 * value from one the next document needs. It is worth refusing: a value nothing
 * substitutes is a placeholder that was renamed in the template and not here, and the
 * document it was meant for would otherwise be applied with the old name still in it.
 */
function renderAll(values) {
  const names = templateNames();
  if (names.length === 0) {
    throw new Error(`no ${templateSuffix} document in ${iamDir}`);
  }
  const used = new Set();
  for (const name of names) {
    for (const placeholder of placeholdersIn(readTemplate(name))) {
      used.add(placeholder);
    }
  }
  for (const placeholder of Object.keys(values)) {
    if (!used.has(placeholder)) {
      throw new Error(`a value was supplied for \${${placeholder}}, which no template uses`);
    }
  }
  const rendered = new Map();
  for (const name of names) {
    rendered.set(name, renderIamDocument(readTemplate(name), values));
  }
  return rendered;
}

function usage() {
  return [
    'usage:',
    '  node scripts/render-iam.js --example [--out-dir <dir>]',
    '  node scripts/render-iam.js --account-id <twelve digits>',
    '      --repository-identity <owner@owner-id/repository@repository-id>',
    '      --execution-role-name <name> --route53-hosted-zone-id <id>',
    '      [--out-dir <dir>]',
  ].join('\n');
}

function parseArgv(argv) {
  const options = { example: false, outDir: defaultOutDir, values: {} };
  const flags = new Map([
    ['--account-id', 'ACCOUNT_ID'],
    ['--execution-role-name', 'CLOUDFORMATION_EXECUTION_ROLE_NAME'],
    ['--repository-identity', 'GITHUB_REPOSITORY_IDENTITY'],
    ['--route53-hosted-zone-id', 'ROUTE53_HOSTED_ZONE_ID'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--example') {
      options.example = true;
      continue;
    }
    if (argument === '--out-dir') {
      const next = argv[index + 1];
      if (next === undefined) {
        throw new Error('--out-dir takes a value');
      }
      index += 1;
      options.outDir = path.resolve(next);
      continue;
    }
    const placeholder = flags.get(argument);
    if (placeholder === undefined) {
      throw new Error('unknown argument');
    }
    const next = argv[index + 1];
    if (next === undefined) {
      throw new Error(`${argument} takes a value`);
    }
    if (Object.prototype.hasOwnProperty.call(options.values, placeholder)) {
      throw new Error(`${argument} may be supplied only once`);
    }
    index += 1;
    options.values[placeholder] = next;
  }
  if (options.example && Object.keys(options.values).length > 0) {
    throw new Error('--example renders with example-values.json and takes no value of its own');
  }
  // Writing over the templates would put the rendered account back in the repository,
  // which is the one thing this script exists to keep out of it.
  if (options.outDir === iamDir) {
    throw new Error('--out-dir must not be the template directory itself');
  }
  return options;
}

function main(argv) {
  const options = parseArgv(argv);
  const rendered = renderAll(options.example ? exampleValues() : options.values);
  fs.mkdirSync(options.outDir, { recursive: true });
  for (const [name, document] of rendered) {
    const target = path.join(options.outDir, `${name}.json`);
    fs.writeFileSync(target, document);
    process.stdout.write(`${target}\n`);
  }
  process.stdout.write('These are not committed. Apply them out of band.\n');
}

module.exports = {
  defaultOutDir,
  exampleValues,
  iamDir,
  parseArgv,
  placeholderRules,
  placeholdersIn,
  readTemplate,
  renderAll,
  renderIamDocument,
  templateNames,
  templateSuffix,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
  }
}
