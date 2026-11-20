import { Alias, type Document, parseDocument, visit } from 'yaml';
import { invalidConfig } from '../core/errors.js';

export type ParseYamlOptions = {
  subject: string;
};

const CORE_TAG_PREFIX = 'tag:yaml.org,2002:';

function assertNoExoticNodes(document: Document, subject: string): void {
  visit(document, {
    Node(_key, node) {
      if (node instanceof Alias) {
        throw invalidConfig('YAML aliases are not allowed', {
          subject,
          action: 'write the value out in full',
        });
      }
      if (node.anchor !== undefined) {
        throw invalidConfig('YAML anchors are not allowed', {
          subject,
          action: 'write the value out in full',
        });
      }
      if (node.tag !== undefined && !String(node.tag).startsWith(CORE_TAG_PREFIX)) {
        throw invalidConfig('YAML custom tags are not allowed', { subject });
      }
    },
  });
}

/**
 * Parse one plain YAML document with duplicate keys rejected, anchors,
 * aliases and custom tags refused. Returns the document's plain value.
 */
export function parseYamlStrict<T = unknown>(text: string, options: ParseYamlOptions): T {
  const document: Document = parseDocument(text, {
    uniqueKeys: true,
    schema: 'core',
    logLevel: 'silent',
  });
  for (const error of document.errors) {
    throw invalidConfig(error.message, { subject: options.subject });
  }
  assertNoExoticNodes(document, options.subject);
  return document.toJS() as T;
}
