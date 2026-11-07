/**
 * Name-pattern helpers shared by member tool resolution and prompt-section
 * filtering. A pattern is anchored, `*` matches any run, and the rest is a
 * regex fragment (so `browser-use:*` matches every `browser-use:` name).
 * @module dsh-agent-teams/glob
 */
/** Compile a name pattern into an anchored RegExp, or undefined when empty/invalid. */
export declare function patternToRegExp(pattern: string): RegExp | undefined;
/** Whether a name matches any compiled pattern. */
export declare function matchesAnyPattern(name: string, patterns: readonly RegExp[]): boolean;
