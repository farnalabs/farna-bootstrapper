import { z } from 'zod';
import { ID_MAX_LENGTH, ID_RE } from '../core/constants.js';

export const idSchema = z.string().regex(ID_RE, 'must be lower-case kebab-case').max(ID_MAX_LENGTH);

export const personaSchema = z
  .strictObject({
    kind: z.literal('persona'),
    id: idSchema,
    displayName: z.string().min(1).max(80),
    purpose: z.string().min(1).max(120),
    resources: z.array(z.string().min(1)).max(200),
    model: idSchema.optional(),
  })
  .superRefine((persona, ctx) => {
    const seen = new Set<string>();
    for (const ref of persona.resources) {
      const match = /^([a-z]+)\/(.+)$/.exec(ref);
      if (match === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['resources'],
          message: `"${ref}" is not a "kind/id" reference`,
        });
        continue;
      }
      if (seen.has(ref)) {
        ctx.addIssue({
          code: 'custom',
          path: ['resources'],
          message: `duplicate reference "${ref}"`,
        });
      }
      seen.add(ref);
    }
  });

export const ruleFrontmatterSchema = z.strictObject({
  kind: z.literal('rule'),
  id: idSchema,
  displayName: z.string().min(1).max(80).optional(),
  description: z.string().min(1).max(200).optional(),
});

export type PersonaDeclaration = z.infer<typeof personaSchema>;
export type RuleFrontmatter = z.infer<typeof ruleFrontmatterSchema>;
