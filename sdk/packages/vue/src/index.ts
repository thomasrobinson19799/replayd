/**
 * @replayd/vue (PRD §4.1): `app.use(ReplaydVue, options?)`. Chains `app.config.errorHandler`: errors are reported
 * with source `vue`, the component name and the lifecycle info, then passed to the previous handler (or logged
 * like Vue does without one; core skips the already-reported error on the console path).
 * `options` (with `dsn`) also calls `init()`; omit them when `init()` already ran.
 */
import type { App, ComponentPublicInstance } from 'vue';
import { captureException, init, type ReplaydOptions } from '@replayd/core';

type Vm = ComponentPublicInstance | null;
/** component name: `name`, SFC `__name`, or the file name */
export const componentName = (vm: Vm): string | undefined => {
  const o = vm?.$options as { name?: string; __name?: string; __file?: string } | undefined;
  return o?.name || o?.__name || o?.__file?.split(/[\\/]/).pop();
};

export const ReplaydVue = {
  install(app: App, o?: ReplaydOptions): void {
    if (o?.dsn) init(o);
    const prev = app.config.errorHandler;
    app.config.errorHandler = (err: unknown, vm: Vm, info: string) => {
      captureException(err, { source: 'vue', ctx: { component: componentName(vm), info } });
      if (prev) prev(err, vm, info);
      else console.error(err);
    };
  },
};
export default ReplaydVue;
