/**
 * How to run this CLI again, for the commands it prints for a person or an agent to copy.
 *
 * Started through npx (`npx basedagents@latest …`, the way the docs run it), nothing is
 * installed, so a bare `basedagents` would answer "command not found": print the npx form.
 * npx runs the package from npm's `_npx` cache and sets npm_command=exec. Installed, the
 * name alone works.
 */
export function cliCommand(env: NodeJS.ProcessEnv = process.env, argv1: string = process.argv[1] ?? ''): string {
  const viaNpx = env.npm_command === 'exec' || /[\\/]_npx[\\/]/.test(argv1);
  return viaNpx ? 'npx basedagents@latest' : 'basedagents';
}
