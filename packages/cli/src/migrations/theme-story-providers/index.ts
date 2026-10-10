import type { Rule } from '@angular-devkit/schematics';
import { JsonFile } from '../../utils/json-file';
import { replaceGeneratedText } from '../edit';

/** The head of the story, as 22.5 to 22.9 wrote it, down to the end of `meta`. */
const GENERATED = `import type { Meta, StoryObj } from '@storybook/angular-vite';
import { ThemeToggle } from './theme-toggle';

/**
 * The toggle drives \`data-theme\` and \`data-palette\` on \`<html>\` — the same two
 * attributes Storybook's own toolbar writes, and the same two the application
 * uses. A story that switches the palette here restyles the whole preview
 * frame, which is the point: theming is a document-level concern, not a
 * component input.
 */
const meta: Meta<ThemeToggle> = {
  title: 'Primitives/Theme toggle',
  component: ThemeToggle,
  tags: ['autodocs'],
};`;

const DECORATOR = 'decorators: [applicationConfig({ providers: [provideTheme()] })],';

const REPLACEMENT = `import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular-vite';
import { provideTheme } from './theme';
import { ThemeToggle } from './theme-toggle';

/**
 * The toggle drives \`data-theme\` and \`data-palette\` on \`<html>\` — the same two
 * attributes Storybook's own toolbar writes, and the same two the application
 * uses. A story that switches the palette here restyles the whole preview
 * frame, which is the point: theming is a document-level concern, not a
 * component input.
 */
const meta: Meta<ThemeToggle> = {
  title: 'Primitives/Theme toggle',
  component: ThemeToggle,
  tags: ['autodocs'],
  // \`ThemeService\` takes its palettes from \`provideTheme()\`, which an app calls
  // in its \`app.config.ts\` and a story, rendered outside any app, calls here.
  ${DECORATOR}
};`;

const MANUAL =
  "Import `applicationConfig` from '@storybook/angular-vite' and `provideTheme` " +
  `from './theme', and add \`${DECORATOR}\` to its \`meta\`, so the story can create ` +
  '`ThemeService`.';

/**
 * Gives the theme toggle's story the `provideTheme()` an app gives the toggle.
 *
 * Since 22.6 `ThemeService` is @angular-capacitor-workspace/theming, which
 * takes its palettes from `provideTheme()` and throws without them, and the
 * story rendered the toggle with no providers at all.
 *
 * Only a design system whose binding exports `provideTheme`. Before 22.6 the
 * service was generated into the library, provided in root, and the same story
 * renders as it is.
 */
export function themeStoryProviders(): Rule {
  return (tree, context) => {
    let projects: Record<string, { root?: string; projectType?: string }>;
    try {
      projects = new JsonFile(tree, '/angular.json').get(['projects']) ?? {};
    } catch {
      context.logger.warn(
        'Left the theme toggle story as it is: angular.json does not parse. In the ' +
          `design system's src/lib/theme/theme-toggle.stories.ts: ${MANUAL}`,
      );
      return;
    }

    for (const { root, projectType } of Object.values(projects)) {
      if (projectType !== 'library' || root === undefined) {
        continue;
      }
      const theme = `/${root}/src/lib/theme`;
      const binding = tree.read(`${theme}/theme.ts`)?.toString('utf8') ?? '';
      if (!binding.includes('export function provideTheme(')) {
        continue;
      }
      replaceGeneratedText(tree, context.logger, `${theme}/theme-toggle.stories.ts`, {
        generated: GENERATED,
        replacement: REPLACEMENT,
        manual: MANUAL,
      });
    }
  };
}
