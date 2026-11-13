/**
 * @file src/agent/schemas.js
 * @module agent/schemas
 * @purpose JSON schemas for AI role responses: decomposer, extender, rectifier, restorer.
 * @exports SUB_REFERENCE_KINDS, DECOMPOSER_KINDS, DECOMPOSER_SCHEMA, DECOMPOSER_INLINE_SCHEMA, EXTEND_SCHEMA, RECTIFY_SCHEMA, RESTORE_SCHEMA, RESTORE_VERIFY_SCHEMA
 * @ai.tags schema
 * @ai.hint keep
 */

const string = { type: 'string' };
const strings = { type: 'array', items: string };
const nullableString = { type: ['string', 'null'] };
const nullableInteger = { type: ['integer', 'null'] };
const nullableNumber = { type: ['number', 'null'] };
const object = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

export const SUB_REFERENCE_KINDS = ['crop', 'split', 'restored', 'repaired', 'regenerated', 'figma-export'];

/**
 * The kinds a sub-reference may carry. The empty kind means "the role did not say how it was
 * produced" — a screen without a file has no kind at all.
 */
export const DECOMPOSER_KINDS = ['', ...SUB_REFERENCE_KINDS];

export const DECOMPOSER_SCHEMA = object({
    summary: { ...string, description: 'How the provided design divides into screens or meaningful fragments.' },
    screens: {
        type: 'array',
        description: 'Ordered screens or reusable sections.',
        items: object({
            name: { ...string, description: 'Short screen or fragment name.' },
            source: { ...string, description: 'Source image path or Figma URL/node link.' },
            nodeId: { ...nullableString, description: 'Figma node id when available.' },
            purpose: { ...string, description: 'What this screen represents.' },
            bounds: { ...nullableString, description: 'Image coordinates or Figma frame bounds.' },
            references: { ...strings, description: 'Other screens or nodes related to this one.' },
            subReference: { ...nullableString, description: 'Path of the image produced for this screen.' },
            subReferenceKind: { type: 'string', enum: DECOMPOSER_KINDS, description: 'How this sub-reference was produced.' },
        }),
    },
    subReferences: {
        type: 'array',
        description: 'Every image file with its screen, kind, source, and what was corrected.',
        items: object({
            path: { ...string, description: 'Path of the image file.' },
            screen: { ...string, description: 'Screen this belongs to.' },
            kind: { type: { enum: DECOMPOSER_KINDS, description: 'How this was produced.' } },
            source: { ...string, description: 'Source reference.' },
            note: { ...string, description: 'Notes about corrections or regeneration.' },
        }),
    },
    notes: { ...strings, description: 'Ambiguities, inaccessible sources, or regeneration notes.' },
});

const rect = object({
    x: { type: 'integer', description: 'Left edge of the screen in the pixels of the picture the model saw.' },
    y: { type: 'integer', description: 'Top edge of the screen in the pixels of the picture the model saw.' },
    width: { type: 'integer', description: 'Width of the screen in pixels.' },
    height: { type: 'integer', description: 'Height of the screen in pixels.' },
});

/**
 * The answer of the decomposer in inline mode: the same screens as in agent mode, but with the
 * rectangle of every screen instead of a file. The harness cuts the pixels itself.
 */
export const DECOMPOSER_INLINE_SCHEMA = object({
    summary: { ...string, description: 'How the provided design divides into screens or meaningful fragments.' },
    screens: {
        type: 'array',
        description: 'Ordered screens or reusable sections.',
        items: object({
            name: { ...string, description: 'Short screen or fragment name.' },
            source: { ...string, description: 'Source image path or Figma URL/node link.' },
            nodeId: { ...nullableString, description: 'Figma node id when available.' },
            purpose: { ...string, description: 'What this screen represents.' },
            bounds: { ...nullableString, description: 'Image coordinates or Figma frame bounds.' },
            references: { ...strings, description: 'Other screens or nodes related to this one.' },
            rect: { ...rect, description: 'The rectangle of the screen in the picture the model saw.' },
            subReference: { ...nullableString, description: 'Filled in by the harness with the file it cut.' },
            subReferenceKind: { type: 'string', enum: DECOMPOSER_KINDS, description: 'How this sub-reference was produced.' },
        }),
    },
    subReferences: {
        type: 'array',
        description: 'Empty in inline mode: the harness writes the files.',
        items: object({
            path: { ...string, description: 'Path of the image file.' },
            screen: { ...string, description: 'Screen this belongs to.' },
            kind: { type: { enum: DECOMPOSER_KINDS, description: 'How this was produced.' } },
            source: { ...string, description: 'Source reference.' },
            note: { ...string, description: 'Notes about corrections or regeneration.' },
        }),
    },
    notes: { ...strings, description: 'Ambiguities, inaccessible sources, or regeneration notes.' },
});

export const EXTEND_SCHEMA = object({
    verdict: { type: 'string', enum: ['keep', 'extend'], description: 'keep when complete; extend when cut through content.' },
    assessment: { ...string, description: 'What is cut off and where, or why the frame is complete.' },
    edge: { type: 'string', enum: ['', 'bottom', 'right', 'top', 'left'], description: 'The edge the content is clipped by.' },
    prompt: { ...string, description: 'Instruction for the image editor for the empty band.' },
});

const quadCorner = object({
    x: { type: 'number', description: 'X in pixels from the left edge.' },
    y: { type: 'number', description: 'Y in pixels from the top edge.' },
});

export const RECTIFY_SCHEMA = object({
    verdict: { type: 'string', enum: ['keep', 'rectified', 'unresolved'], description: 'keep=flat, rectified=projection applied, unresolved=need data.' },
    assessment: { ...string, description: 'What the picture is and how each screen sits.' },
    screens: {
        type: 'array',
        maxItems: 8,
        description: 'One entry per file produced.',
        items: object({
            label: { ...string, description: 'Screen label.' },
            output: { ...string, description: 'Path of the rectified file.' },
            quad: { ...object({
                tl: { ...quadCorner, description: 'Top-left corner.' },
                tr: { ...quadCorner, description: 'Top-right corner.' },
                br: { ...quadCorner, description: 'Bottom-right corner.' },
                bl: { ...quadCorner, description: 'Bottom-left corner.' },
            }), description: 'Four corners passed to correct_perspective.' },
        }),
    },
});

export const RESTORE_DEFECT_KINDS = ['leftover', 'missing', 'seam', 'artefact'];

export const RESTORE_SCHEMA = object({
    verdict: { type: 'string', enum: ['clean', 'repair'], description: 'clean=usable, repair=needs fixes.' },
    assessment: { ...string, description: 'What you see and why.' },
    patches: {
        type: 'array',
        description: 'Regions to repair in sub-reference pixels.',
        items: object({
            kind: { type: 'string', enum: RESTORE_DEFECT_KINDS, description: 'Type of defect.' },
            x: { type: 'integer', description: 'Left edge in pixels.' },
            y: { type: 'integer', description: 'Top edge in pixels.' },
            width: { type: 'integer', description: 'Width of the region.' },
            height: { type: 'integer', description: 'Height of the region.' },
            finding: { ...string, description: 'What is wrong, stated as an observed fact.' },
            prompt: { ...string, description: 'Instruction for the image editor.' },
        }),
    },
});

export const RESTORE_VERIFY_SCHEMA = object({
    verdict: { type: 'string', enum: ['better', 'same', 'worse'], description: 'better=defect gone, worse=anything else changed.' },
    reason: { ...string, description: 'One sentence naming what changed.' },
});