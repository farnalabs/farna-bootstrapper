/**
 * Text that reaches a human line. A subject can come from a source tree, a
 * lockfile a user can hand-edit, or a renderer, so it is never printed raw: a C0
 * or C1 control character would let a path rewrite the terminal line it is
 * printed on (carriage return, backspace, an ANSI escape introducer).
 */

function isControlCode(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** True when the string contains a C0, DEL or C1 control character. */
export function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    if (isControlCode(character.codePointAt(0) ?? 0)) {
      return true;
    }
  }
  return false;
}

/** Escape every control character as a visible `\uXXXX` sequence. */
export function escapeControlCharacters(value: string): string {
  let escaped = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    escaped += isControlCode(code) ? `\\u${code.toString(16).padStart(4, '0')}` : character;
  }
  return escaped;
}
