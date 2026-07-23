/**
 * Live evidence-gathering probe for the cloud reference classifier.
 *
 * Unlike `cloud-classifier-smoke.ts` (a pass/fail contract test against one model),
 * this probe runs the app's exact classification transport against a matrix of
 * models and reports, for each one, everything the app would have done with the
 * response: HTTP status, the shape of `message.content`, the text the app would
 * extract, and the final ClassificationOutcome including the validation reason.
 * It never fails on a bad model answer — the printed evidence is the deliverable.
 * Never logs the API key or the Authorization header.
 *
 * Run: NANOGPT_API_KEY=... npx vitest run --config vitest.smoke.config.ts scripts/classifier-matrix-smoke.ts
 * Model list override: SMOKE_MATRIX_MODELS=a,b,c
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createCloudReferenceClassifier } from '../src/js/references/cloud-classifier.js';
import type { ReferenceAsset, WorldLocation } from '../src/js/references/types.js';

const BASE_URL = 'https://nano-gpt.com/api/v1';
const API_KEY = process.env.NANOGPT_API_KEY || '';
const IMAGE_MODEL = process.env.SMOKE_IMAGE_MODEL || 'flux-schnell';
const CACHE_DIR = process.env.SMOKE_CACHE_DIR || path.join(process.cwd(), '.smoke-cache');
const IMAGE_PATH = path.join(CACHE_DIR, 'mara-courtyard.png');
const REPORT_PATH = path.join(CACHE_DIR, 'classifier-matrix-report.json');

/**
 * The matrix deliberately covers the app's risk classes:
 * - `gpt-4o-mini`: the app's DEFAULT text model id (`getModel()` fallback). It is
 *   NOT in the current NanoGPT catalog (only `openai/gpt-4o-mini` is), so the
 *   vision gate cannot see it and the app attempts it blind.
 * - `openai/gpt-4o-mini`: the catalog id for the same model.
 * - `gemini-2.5-flash`: a popular vision-capable pick.
 * - `xiaomi/mimo-v2.5:thinking`: cheap vision+reasoning model — probes what the
 *   app's fixed `max_tokens: 600` does when reasoning tokens eat the budget.
 */
const DEFAULT_MODELS = ['gpt-4o-mini', 'openai/gpt-4o-mini', 'gemini-2.5-flash', 'xiaomi/mimo-v2.5:thinking'];
const MODELS = (process.env.SMOKE_MATRIX_MODELS || DEFAULT_MODELS.join(','))
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const PROMPT =
  'Comic book character reference illustration: a woman named Mara with short black hair wearing a long red coat, ' +
  'standing facing the viewer, full body, front view, in a stone castle courtyard at night with wall torches. ' +
  'Clean comic art, flat colors, bold ink lines.';

async function getTestImage(): Promise<Buffer> {
  try {
    return await readFile(IMAGE_PATH);
  } catch {
    /* fall through and generate */
  }
  const response = await fetch(`${BASE_URL}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt: PROMPT, response_format: 'b64_json', n: 1 }),
  });
  if (!response.ok) throw new Error(`image generation failed: HTTP ${response.status}`);
  const body = await response.json();
  const b64 = body?.data?.[0]?.b64_json;
  if (!b64) throw new Error('image generation returned no b64_json payload');
  const buffer = Buffer.from(b64, 'base64');
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(IMAGE_PATH, buffer);
  return buffer;
}

/** Mirror the browser's compressDataUrl(dataUrl, 512, 0.75) so the model sees what the app sends. */
async function toCompressedDataUrl(buffer: Buffer): Promise<string> {
  const jpeg = await sharp(buffer).resize(512, 512, { fit: 'inside' }).jpeg({ quality: 75 }).toBuffer();
  return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}

const world = { id: 'w1', name: 'Ravenspire', description: 'A hilltop stone fortress under permanent overcast.' };
const characters = [
  { id: 'mara', name: 'Mara', appearance: 'Short black hair, long red coat.' },
  { id: 'theo', name: 'Theo', appearance: 'Tall, blond, green cloak.' },
];
const locations: WorldLocation[] = [
  { id: 'yard', worldId: 'w1', name: 'Castle courtyard', aliases: ['yard', 'courtyard'] },
  { id: 'hall', worldId: 'w1', name: 'Great hall', aliases: ['hall'] },
];

function asset(dataUrl: string): ReferenceAsset {
  return {
    id: 'r1',
    worldId: 'w1',
    dataUrl,
    subjectType: null,
    use: null,
    characterIds: [],
    locationId: null,
    facets: {},
    description: '',
    confidence: {},
    provenance: { source: 'uploaded', metadata: 'local' },
    classificationState: 'pending',
    acceptedAsIs: false,
    autoUse: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

interface ModelEvidence {
  model: string;
  httpStatus?: number;
  httpErrorExcerpt?: string;
  finishReason?: unknown;
  usage?: unknown;
  contentType?: string;
  hasReasoningField?: boolean;
  appExtractedText?: string | null;
  appTransportThrow?: string;
  outcome?: unknown;
}

/**
 * Replays src/js/api.ts `chatCompletion` + `classifyReferenceImage` byte-for-byte:
 * same body (including the settings-default top_p 0.9), same
 * `choices[0].message.content || ''` coercion, same `.trim() || null` — so a
 * response shape that breaks the app breaks here in exactly the same way.
 */
async function callLikeTheApp(model: string, dataUrl: string, prompt: string, evidence: ModelEvidence) {
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content:
            'You are a precise visual classifier for a comic book creator. Reply with one raw JSON object and nothing else.',
        },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: dataUrl } },
            { type: 'text', text: prompt },
          ],
        },
      ],
      temperature: 0.1,
      top_p: 0.9,
      max_tokens: 600,
    }),
  });
  evidence.httpStatus = response.status;
  if (!response.ok) {
    const err: any = await response.json().catch(() => ({}));
    evidence.httpErrorExcerpt = JSON.stringify(err).slice(0, 500);
    throw new Error(err.error?.message || `API error: ${response.status}`);
  }
  const data: any = await response.json();
  const message = data.choices?.[0]?.message;
  evidence.finishReason = data.choices?.[0]?.finish_reason;
  evidence.usage = data.usage;
  evidence.contentType = Array.isArray(message?.content) ? 'array' : typeof message?.content;
  evidence.hasReasoningField = Boolean(message?.reasoning || message?.reasoning_content);
  const content = message?.content || '';
  // classifyReferenceImage: `response?.trim() || null` — throws on non-string content.
  return (content as string).trim() || null;
}

it('captures classifier evidence across the model matrix', { timeout: 600_000 }, async () => {
  expect(API_KEY, 'NANOGPT_API_KEY must be set').not.toBe('');
  const dataUrl = await toCompressedDataUrl(await getTestImage());
  const report: ModelEvidence[] = [];

  for (const model of MODELS) {
    const evidence: ModelEvidence = { model };
    let rawText = '';
    const classifier = createCloudReferenceClassifier({
      isConfigured: async () => true,
      classifyImage: async (imageDataUrl, prompt) => {
        const text = await callLikeTheApp(model, imageDataUrl, prompt, evidence);
        rawText = typeof text === 'string' ? text : '';
        return text;
      },
    });

    try {
      const outcome = await classifier.classify({ asset: asset(dataUrl), world, characters, locations });
      evidence.appExtractedText = rawText || null;
      evidence.outcome = outcome;
    } catch (error) {
      // createCloudReferenceClassifier never throws; reaching here means the
      // transport replay itself crashed the way api.ts would (e.g. content array).
      evidence.appTransportThrow = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    }

    console.log(`\n===== model: ${model} =====`);
    console.log(`http: ${evidence.httpStatus} finish_reason: ${JSON.stringify(evidence.finishReason)}`);
    console.log(`content type: ${evidence.contentType} reasoning field: ${evidence.hasReasoningField}`);
    console.log(`usage: ${JSON.stringify(evidence.usage)}`);
    if (evidence.httpErrorExcerpt) console.log(`http error: ${evidence.httpErrorExcerpt}`);
    if (evidence.appTransportThrow) console.log(`app transport would throw: ${evidence.appTransportThrow}`);
    console.log(`raw text the app would parse:\n${rawText || '(empty)'}`);
    console.log(`outcome: ${JSON.stringify(evidence.outcome, null, 2)}`);
    report.push(evidence);
  }

  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  // Evidence-gathering probe: assert only that every model produced a record.
  expect(report).toHaveLength(MODELS.length);
});
