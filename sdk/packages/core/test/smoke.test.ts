import { describe, expect, it } from 'vitest';
import { init, SDK_VERSION } from '../src/index';

describe('core scaffold', () => {
  it('exports init and version', () => {
    expect(typeof init).toBe('function');
    expect(typeof SDK_VERSION).toBe('string');
  });
});
