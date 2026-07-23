/**
 * Live smoke probe for the cloud reference classifier.
 *
 * Exercises the real `createCloudReferenceClassifier` against NanoGPT with a real
 * image, so the shared prompt, the model's JSON, and the schema validation are all
 * tested end to end. Never logs the API key or the Authorization header.
 *
 * Run: NANOGPT_API_KEY=... npx vitest run --config <config> (see the smoke config)
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { expect, it } from 'vitest';
import { createCloudReferenceClassifier } from '../src/js/references/cloud-classifier.js';
import type { ReferenceAsset, WorldLocation } from '../src/js/references/types.js';

const BASE_URL = 'https://nano-gpt.com/api/v1';
const API_KEY = process.env.NANOGPT_API_KEY || '';
const MODEL = process.env.SMOKE_VISION_MODEL || 'gpt-4o-mini';
const IMAGE_MODEL = process.env.SMOKE_IMAGE_MODEL || 'flux-schnell';
const CACHE_DIR = process.env.SMOKE_CACHE_DIR || path.join(process.cwd(), '.smoke-cache');
const IMAGE_PATH = path.join(CACHE_DIR, 'mara-courtyard.png');

const PROMPT =
  'Comic book character reference illustration: a woman named Mara with short black hair wearing a long red coat, ' +
  'standing facing the viewer, full body, front view, in a stone castle courtyard at night with wall torches. ' +
  'Clean comic art, flat colors, bold ink lines.';

/** Reuse a cached image across runs so repeated smoke tests do not re-bill generation. */
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

it('classifies a real reference image through the real cloud classifier', { timeout: 180_000 }, async () => {
  expect(API_KEY, 'NANOGPT_API_KEY must be set').not.toBe('');

  const dataUrl = await toCompressedDataUrl(await getTestImage());
  const asset: ReferenceAsset = {
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

  let rawResponse = '';
  const classifier = createCloudReferenceClassifier({
    isConfigured: async () => Boolean(API_KEY),
    classifyImage: async (imageDataUrl, prompt) => {
      const response = await fetch(`${BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 600,
          temperature: 0.1,
          messages: [
            {
              role: 'system',
              content:
                'You are a precise visual classifier for a comic book creator. Reply with one raw JSON object and nothing else.',
            },
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: imageDataUrl } },
                { type: 'text', text: prompt },
              ],
            },
          ],
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      rawResponse = body?.choices?.[0]?.message?.content ?? '';
      return rawResponse;
    },
  });

  const outcome = await classifier.classify({ asset, world, characters, locations });

  console.log(`\nmodel: ${MODEL}`);
  console.log(`raw model output:\n${rawResponse}\n`);
  console.log(`outcome: ${JSON.stringify(outcome, null, 2)}\n`);

  expect(outcome.kind, `classifier returned ${outcome.kind}`).toBe('classified');
  if (outcome.kind !== 'classified') return;
  // The image plainly shows Mara in the courtyard, so a working end-to-end path must link both.
  expect(outcome.classification.characterIds).toContain('mara');
  expect(outcome.classification.locationId).toBe('yard');
  expect(outcome.classification.subjectType).toBe('character');
});
