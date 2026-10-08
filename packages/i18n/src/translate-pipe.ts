import { Pipe, inject, type PipeTransform } from '@angular/core';
import type { TranslationParams } from './config';
import { TranslationService } from './translation';

function sameParams(a: TranslationParams | undefined, b: TranslationParams | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  return keys.every((key) => a[key] === b[key]);
}

/**
 * Translates a message key in a template:
 *
 *     {{ 'app.title' | t }}
 *     {{ 'home.greeting' | t: { name: person() } }}
 *     {{ 'cart.items' | t: { count: items().length } }}
 *
 * ## Why `pure: false`
 *
 * A pure pipe would be wrong twice over. Angular short-circuits pure pipes on
 * unchanged inputs, so `transform` would never re-run when only the LOCALE
 * changed — the key string is still `'app.title'`. And because that skipped run
 * never re-reads the service's signals, the host view would also stop being a
 * consumer of them, so under zoneless change detection nothing would even mark
 * it dirty.
 *
 * So the pipe is impure and reads `revision()` on every pass: the read
 * subscribes the host view (locale change → view dirty → re-render), and the
 * value doubles as a memo key, so the actual lookup only happens when the key,
 * the params or the messages genuinely changed. Every other pass is three
 * comparisons.
 */
@Pipe({ name: 't', pure: false })
export class TranslatePipe implements PipeTransform {
  private readonly i18n = inject(TranslationService);

  private key: string | undefined;
  private params: TranslationParams | undefined;
  private revision: string | undefined;
  private value = '';

  transform(key: string, params?: TranslationParams): string {
    const revision = this.i18n.revision();
    if (revision === this.revision && key === this.key && sameParams(params, this.params)) {
      return this.value;
    }

    this.revision = revision;
    this.key = key;
    this.params = params;
    this.value = this.i18n.translate(key, params);
    return this.value;
  }
}
