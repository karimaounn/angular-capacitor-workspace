import { HostTree } from '@angular-devkit/schematics';
import { SchematicsException } from '@angular-devkit/schematics';
import { describe, expect, it } from 'vitest';
import { JsonFile } from '../src/utils/json-file';

function treeWith(path: string, content: string): HostTree {
  const tree = new HostTree();
  tree.create(path, content);
  return tree;
}

describe('JsonFile', () => {
  it('preserves comments and formatting around an edit', () => {
    // Angular's tsconfig.json ships with leading block comments. A patch that
    // reserialises the document would delete them, turning a one-key change
    // into a whole-file diff.
    const original = `/* Learn more about tsconfig. */
{
  "compilerOptions": {
    "target": "ES2022"
  }
}
`;
    const tree = treeWith('/tsconfig.json', original);
    const file = new JsonFile(tree, '/tsconfig.json');

    file.modify(['compilerOptions', 'paths'], {});
    file.save();

    const result = tree.read('/tsconfig.json')!.toString('utf8');
    expect(result).toContain('/* Learn more about tsconfig. */');
    expect(result).toContain('"target": "ES2022"');
    expect(JSON.parse(stripComments(result)).compilerOptions.paths).toEqual({});
  });

  it('throws with the expectation when an anchor is missing', () => {
    const tree = treeWith('/angular.json', '{ "projects": {} }');
    const file = new JsonFile(tree, '/angular.json');

    expect(() =>
      file.mustGet(['projects', 'shop', 'architect', 'build'], 'the build target'),
    ).toThrow(SchematicsException);
    expect(() => file.mustGet(['projects', 'shop'], 'the shop project')).toThrow(
      /Anchor not found in \/angular\.json: the shop project/,
    );
  });

  it('throws when the file does not exist', () => {
    expect(() => new JsonFile(new HostTree(), '/nope.json')).toThrow(
      /Expected \/nope\.json to exist/,
    );
  });

  it('throws on malformed JSON rather than silently rewriting it', () => {
    const tree = treeWith('/broken.json', '{ "a": ');
    expect(() => new JsonFile(tree, '/broken.json')).toThrow(/is not valid JSON/);
  });

  it('removes a key, and removal is idempotent', () => {
    const tree = treeWith('/package.json', '{ "scripts": { "serve:ssr:site": "node x.mjs" } }');
    const file = new JsonFile(tree, '/package.json');

    file.remove(['scripts', 'serve:ssr:site']);
    file.remove(['scripts', 'serve:ssr:site']);
    file.save();

    expect(JSON.parse(tree.read('/package.json')!.toString('utf8')).scripts).toEqual({});
  });

  it('sorts an object in place', () => {
    const tree = treeWith('/package.json', '{ "devDependencies": { "zod": "1", "axios": "2" } }');
    const file = new JsonFile(tree, '/package.json');

    file.sortKeys(['devDependencies']);
    file.save();

    const parsed = JSON.parse(tree.read('/package.json')!.toString('utf8'));
    expect(Object.keys(parsed.devDependencies)).toEqual(['axios', 'zod']);
  });

  it('creates intermediate objects when modifying a deep path', () => {
    const tree = treeWith('/angular.json', '{ "projects": { "shop": {} } }');
    const file = new JsonFile(tree, '/angular.json');

    file.modify(
      [
        'projects',
        'shop',
        'architect',
        'build',
        'options',
        'stylePreprocessorOptions',
        'includePaths',
      ],
      ['dist'],
    );
    file.save();

    const parsed = JSON.parse(tree.read('/angular.json')!.toString('utf8'));
    expect(
      parsed.projects.shop.architect.build.options.stylePreprocessorOptions.includePaths,
    ).toEqual(['dist']);
  });
});

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}
