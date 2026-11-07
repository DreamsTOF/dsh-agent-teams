/**
 * Name-pattern helpers shared by member tool resolution and prompt-section
 * filtering. A pattern is anchored, `*` matches any run, and the rest is a
 * regex fragment (so `browser-use:*` matches every `browser-use:` name).
 * @module dsh-agent-teams/glob
 */

/** Compile a name pattern into an anchored RegExp, or undefined when empty/invalid. */
export function patternToRegExp(pattern: string): RegExp | undefined {
  const trimmed = pattern.trim()
  if (trimmed === '') return undefined
  try {
    return new RegExp(`^(?:${trimmed.replace(/\*/g, '.*')})$`)
  } catch {
    return undefined
  }
}

/** Whether a name matches any compiled pattern. */
export function matchesAnyPattern(name: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(regex => regex.test(name))
}
