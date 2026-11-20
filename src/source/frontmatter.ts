import { invalidConfig } from '../core/errors.js';

export type Frontmatter = {
  /** The raw frontmatter text between the delimiters. */
  text: string;
  /** Everything after the closing delimiter line, byte for byte (LF-normalised). */
  body: string;
};

const OPEN = '---\n';
const CLOSE = /^---[ \t]*$/m;

/**
 * Split a markdown file with YAML frontmatter. The frontmatter block must be
 * the first bytes of the file; CRLF is normalised before parsing. The body is
 * never trimmed.
 */
export function splitFrontmatter(source: string, subject: string): Frontmatter {
  const text = source.replace(/\r\n/g, '\n');
  if (!text.startsWith(OPEN)) {
    throw invalidConfig('file must start with a "---" frontmatter block', {
      subject,
      action: 'put the YAML frontmatter on the first line, with no leading blank line',
    });
  }
  const rest = text.slice(OPEN.length);
  const match = CLOSE.exec(rest);
  if (match === null || match.index === undefined) {
    throw invalidConfig('frontmatter block is not closed', {
      subject,
      action: 'add a closing "---" line',
    });
  }
  const frontmatterText = rest.slice(0, match.index);
  const afterClose = rest.indexOf('\n', match.index);
  const body = afterClose === -1 ? '' : rest.slice(afterClose + 1);
  return { text: frontmatterText, body };
}
