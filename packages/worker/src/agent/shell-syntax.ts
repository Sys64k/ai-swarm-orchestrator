/** Shell operators agents write out of habit. run_command has no shell, so they would reach the program as arguments. */
const OPERATORS = new Set(["|", "||", "|&", "&&", ";", "&", "<", "<<"]);
/** Redirections: `>`, `>>`, `2>&1`, `>&2`, `&>`, and ones joined to their target, `>out.txt`, `2>/dev/null`. */
const REDIRECTION = /^(\d?>>?|&>>?)(&\d)?(\S*)$/;

const isShellToken = (word: string) => OPERATORS.has(word) || REDIRECTION.test(word);
const quoted = (words: readonly string[]) => `[${words.map((w) => JSON.stringify(w)).join(", ")}]`;

/**
 * Why run_command refuses this argv, or undefined when it has no shell syntax: a pipe, `&&`, a
 * redirection, or a whole command line in one string. Weak models write these out of habit and
 * lose turns to the confusing results (`head` passed to vitest as a file filter, say), so the
 * refusal names the command to run instead.
 */
export function shellSyntax(argv: readonly string[], outputLimit: number): string | undefined {
  const words = argv.length === 1 && /\s/.test(argv[0].trim()) ? argv[0].trim().split(/\s+/) : [...argv];
  const first = words.findIndex(isShellToken);
  if (first === -1) {
    return words.length > argv.length ? `${JSON.stringify(argv[0])} is a whole command line in one item; give each word as its own item: ${quoted(words)}` : undefined;
  }
  const command = words.slice(0, first);
  const instead = command.length ? `Run ${quoted(command)} instead: ` : "";
  return (
    `\`${words.slice(first).join(" ")}\` is shell syntax, and run_command runs the program without a shell, so it would reach it as arguments. ` +
    `${instead}its output already includes stderr, and you get its last ${outputLimit.toLocaleString("en-US")} characters, so there's nothing to pipe or redirect. ` +
    "Run one program per call; to narrow a test run, pass the test runner's own filter (e.g. a file path or -t <name>)."
  );
}
