import { describe, it, expect } from 'vitest';
import { cliCommand } from './invocation.js';

describe('cliCommand', () => {
  it('is the npx form when started through npx (nothing installed to run by name)', () => {
    expect(cliCommand({ npm_command: 'exec' }, '/home/me/.npm/_npx/678b31851e11b1d7/node_modules/.bin/basedagents')).toBe('npx basedagents@latest');
    expect(cliCommand({}, '/home/me/.npm/_npx/678b31851e11b1d7/node_modules/.bin/basedagents')).toBe('npx basedagents@latest');
    expect(cliCommand({ npm_command: 'exec' }, '')).toBe('npx basedagents@latest');
    expect(cliCommand({}, 'C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\basedagents\\dist\\cli\\index.js')).toBe('npx basedagents@latest');
  });

  it('is the bare name when installed', () => {
    expect(cliCommand({}, '/usr/local/bin/basedagents')).toBe('basedagents');
    expect(cliCommand({ npm_command: 'test' }, '/repo/node_modules/.bin/basedagents')).toBe('basedagents');
    expect(cliCommand({}, '')).toBe('basedagents');
  });
});
