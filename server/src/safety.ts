/**
 * Legal-safety floor. Tide does not moderate general content; the only hard line
 * is sexual content involving minors, which is blocked on prompts and on output.
 */

const ALWAYS = /\b(csam|lolicon|shotacon|loli|shota|child\s*porn|kiddie\s*porn|pedo(phil\w*)?|jailbait|preteen\s*(sex|nude|porn))\b/i;

const MINOR = /\b(child|children|kid|kids|minor|minors|underage|under-age|preteen|pre-teen|toddler|infant|little\s+(girl|boy)|young\s+(girl|boy)|schoolgirl|schoolboy|(1[0-7]|[1-9])\s*(yo|y\/o|years?\s*old|year-old))\b/i;

const SEXUAL = /\b(sex|sexual|sexy|nude|naked|porn\w*|erotic\w*|explicit|genital\w*|penis|vagina|breasts?|nipples?|orgasm\w*|masturbat\w*|intercourse|fuck\w*|blowjob|handjob|aroused|lewd|nsfw|undress\w*|molest\w*)\b/i;

export interface SafetyVerdict { safe: boolean; reason?: string }

export function scanText(text: string): SafetyVerdict {
  if (!text) return { safe: true };
  if (ALWAYS.test(text)) return { safe: false, reason: 'csam' };
  // Evaluate co-occurrence within a sliding window so long, unrelated documents don't trip it.
  const WINDOW = 400;
  for (let i = 0; i < text.length; i += WINDOW / 2) {
    const slice = text.slice(i, i + WINDOW);
    if (MINOR.test(slice) && SEXUAL.test(slice)) return { safe: false, reason: 'csam' };
  }
  return { safe: true };
}

export const BLOCKED_MESSAGE = '[Content blocked by safety filter]';

/**
 * Image prompts: the CSAM floor always applies; with the 18+ toggle off, any sexual term is refused
 * (so SFW users don't get surprised by explicit output).
 */
export function scanImagePrompt(prompt: string, nsfwAllowed: boolean): SafetyVerdict {
  const v = scanText(prompt);
  if (!v.safe) return v;
  if (MINOR.test(prompt) && SEXUAL.test(prompt)) return { safe: false, reason: 'csam' };
  if (!nsfwAllowed && SEXUAL.test(prompt)) return { safe: false, reason: 'nsfw_disabled' };
  return { safe: true };
}
