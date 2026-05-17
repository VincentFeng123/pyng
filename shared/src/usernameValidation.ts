export const COMMON_WORD_BLOCKLIST: Set<string> = new Set([
  'the',
  'and',
  'you',
  'are',
  'for',
  'not',
  'but',
  'all',
  'can',
  'with',
  'this',
  'that',
  'have',
  'from',
  'your',
  'what',
  'when',
  'will',
  'one',
  'get',
  'has',
  'him',
  'his',
  'her',
  'kill',
  'dead',
  'win',
  'lose',
  'fire',
  'gun',
  'shot',
  'hit',
  'miss',
  'run',
  'jump',
  'map',
  'base',
  'team',
  'mate',
  'game',
  'play',
  'ban',
  'mod',
  'dev',
  'admin',
  'user',
  'name',
  'lobby',
  'spec',
  'alive',
  'ping',
]);

export type SoftValidationResult = { ok: true } | { ok: false; warning: string };

export function validateRobloxUsernameSoft(name: string): SoftValidationResult {
  if (name.length > 0 && name.length < 4) {
    return {
      ok: false,
      warning:
        'Short usernames may match unrelated chat or HUD text. Consider using your full Roblox name.',
    };
  }
  if (COMMON_WORD_BLOCKLIST.has(name.toLowerCase())) {
    return {
      ok: false,
      warning:
        'Username matches a common English word. May produce false positives in chat or kill feed.',
    };
  }
  return { ok: true };
}
