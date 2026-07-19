#!/usr/bin/env node

/**
 * Live contract probe for NanoGPT's seedream-v4.5-sequential route.
 *
 * The script deliberately makes no visual pass/fail claim. It verifies the
 * response shape, saves data[i] without reordering, and produces a redacted
 * artifact for human inspection. It never logs the API key, raw response,
 * signed image URLs, or Authorization header.
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = 'https://nano-gpt.com/api/v1/images/generations';
const MODEL = 'seedream-v4.5-sequential';
const SIZE = '1920x1920';
const OUTPUT_COUNT = 4;
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;

const EXPECTED_IMAGES = [
  {
    index: 0,
    label: 'RED ROBOT IN SNOW',
    description:
      'A single glossy red retro robot centered in a white snowy mountain landscape, daytime, no other characters.',
  },
  {
    index: 1,
    label: 'BLUE WHALE UNDERWATER',
    description:
      'A single enormous blue whale centered underwater among pale coral and bubbles, no land and no other animals.',
  },
  {
    index: 2,
    label: 'GREEN KNIGHT IN LIBRARY',
    description:
      'A single knight in vivid green armor centered inside a warm golden medieval library, no other characters.',
  },
  {
    index: 3,
    label: 'YELLOW CAT ON PURPLE MOON',
    description:
      'A single yellow cat astronaut centered on a purple moon beneath a black star field, no other characters.',
  },
];

function buildPrompt() {
  const ordered = EXPECTED_IMAGES.map(
    ({ index, label, description }) => `IMAGE ${index + 1} — ${label}\n${description}`,
  ).join('\n\n');

  return [
    'Generate exactly four separate images in the order listed below.',
    'Each numbered IMAGE is a different, unmistakable scene and must produce one output.',
    'Do not combine the scenes into a collage, grid, contact sheet, or comic page.',
    'Do not move a scene to a different output position.',
    '',
    ordered,
  ].join('\n');
}

function parseRunCount(value) {
  const count = Number.parseInt(value ?? '1', 10);
  if (!Number.isInteger(count) || count < 1 || count > 3) {
    throw new Error('SEEDREAM_TEST_RUNS must be an integer from 1 through 3.');
  }
  return count;
}

function safeRequestId(headers) {
  return headers.get('x-request-id') || headers.get('request-id') || headers.get('cf-ray') || null;
}

function sniffExtension(buffer, contentType = '') {
  const type = contentType.toLowerCase();
  if (type.includes('png')) return 'png';
  if (type.includes('jpeg') || type.includes('jpg')) return 'jpg';
  if (type.includes('webp')) return 'webp';

  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return 'png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return 'bin';
}

function decodeBase64Image(value) {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(value);
  if (match) return { buffer: Buffer.from(match[2], 'base64'), contentType: match[1] };
  return { buffer: Buffer.from(value, 'base64'), contentType: '' };
}

async function loadImage(entry) {
  if (typeof entry?.b64_json === 'string' && entry.b64_json.length > 0) {
    const decoded = decodeBase64Image(entry.b64_json);
    return { ...decoded, source: 'b64_json' };
  }

  if (typeof entry?.url === 'string' && /^https:\/\//i.test(entry.url)) {
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Result download returned HTTP ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());
    return {
      buffer,
      contentType: response.headers.get('content-type') || '',
      source: 'url',
    };
  }

  throw new Error('Response item contains neither b64_json nor an HTTPS URL.');
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildReviewHtml(manifest) {
  const cards = manifest.runs
    .flatMap((run) =>
      run.outputs.map(
        (output) => `
          <article>
            <h2>Run ${run.run}, data[${output.index}]</h2>
            <p><strong>Expected:</strong> ${htmlEscape(output.expectedLabel)}</p>
            <img src="${htmlEscape(output.file)}" alt="Run ${run.run}, data index ${output.index}">
            <p class="meta">${htmlEscape(output.source)} · ${output.bytes} bytes · SHA-256 ${htmlEscape(output.sha256)}</p>
          </article>`,
      ),
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Seedream output-order review</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #1f2937; background: #f8fafc; }
    header { max-width: 70rem; margin: 0 auto 2rem; }
    main { display: grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap: 1.25rem; max-width: 90rem; margin: auto; }
    article { background: white; border: 1px solid #dbe3ec; border-radius: .75rem; padding: 1rem; }
    img { width: 100%; height: auto; border-radius: .5rem; background: #e5e7eb; }
    h1, h2 { line-height: 1.2; }
    h2 { font-size: 1rem; }
    .meta { overflow-wrap: anywhere; color: #64748b; font-size: .75rem; }
  </style>
</head>
<body>
  <header>
    <h1>Seedream output-order contract review</h1>
    <p>Inspect each saved <code>data[index]</code> against its expected scene. These files are saved in API array order and are never reordered by the script.</p>
  </header>
  <main>${cards}</main>
</body>
</html>\n`;
}

function buildSummary(manifest) {
  const lines = [
    '# Seedream output-order contract probe',
    '',
    `- Model: \`${manifest.model}\``,
    `- Size: \`${manifest.size}\``,
    `- Requested outputs per run: ${manifest.outputCount}`,
    `- Completed request runs: ${manifest.runs.length}`,
    '',
    'The structural probe only confirms that indexed outputs were returned and saved without reordering.',
    'Download the artifact and open `review.html` to decide whether each image matches its expected index.',
    '',
    '| Run | API index | Expected scene | File |',
    '| ---: | --------: | -------------- | ---- |',
  ];

  for (const run of manifest.runs) {
    for (const output of run.outputs) {
      lines.push(`| ${run.run} | ${output.index} | ${output.expectedLabel} | \`${output.file}\` |`);
    }
  }
  return `${lines.join('\n')}\n`;
}

async function requestOneRun(apiKey, runNumber, outputDir) {
  console.log(`Submitting live sequential request ${runNumber}...`);
  const startedAt = Date.now();
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODEL,
      prompt: buildPrompt(),
      size: SIZE,
      n: OUTPUT_COUNT,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const requestId = safeRequestId(response.headers);
  if (!response.ok) {
    throw new Error(`NanoGPT image request failed with HTTP ${response.status}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('NanoGPT returned a non-JSON success response.');
  }

  const entries = Array.isArray(payload?.data) ? payload.data : [];
  const outputs = [];

  for (let index = 0; index < Math.min(entries.length, OUTPUT_COUNT); index += 1) {
    const image = await loadImage(entries[index]);
    const extension = sniffExtension(image.buffer, image.contentType);
    const file = `run-${String(runNumber).padStart(2, '0')}-index-${String(index).padStart(2, '0')}.${extension}`;
    await writeFile(path.join(outputDir, file), image.buffer);
    outputs.push({
      index,
      expectedLabel: EXPECTED_IMAGES[index].label,
      file,
      source: image.source,
      bytes: image.buffer.length,
      sha256: createHash('sha256').update(image.buffer).digest('hex'),
    });
  }

  const result = {
    run: runNumber,
    requestId,
    requestedAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    responseEntryCount: entries.length,
    outputs,
  };

  if (entries.length !== OUTPUT_COUNT || outputs.length !== OUTPUT_COUNT) {
    const error = new Error(
      `Expected ${OUTPUT_COUNT} usable indexed images; received ${entries.length} entries and saved ${outputs.length}.`,
    );
    error.partialResult = result;
    throw error;
  }

  console.log(`Saved ${outputs.length} indexed outputs for request ${runNumber}.`);
  return result;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const runCount = parseRunCount(process.env.SEEDREAM_TEST_RUNS);
  const outputDir = path.resolve(process.env.SEEDREAM_OUTPUT_DIR || 'artifacts/seedream-order-test');

  if (dryRun) {
    console.log(
      JSON.stringify(
        {
          endpointOrigin: new URL(ENDPOINT).origin,
          model: MODEL,
          size: SIZE,
          outputCount: OUTPUT_COUNT,
          runs: runCount,
          expectedOrder: EXPECTED_IMAGES.map(({ index, label }) => ({ index, label })),
        },
        null,
        2,
      ),
    );
    return;
  }

  const apiKey = process.env.NANOGPT_API_KEY;
  if (!apiKey) throw new Error('NANOGPT_API_KEY is not available to the approved workflow environment.');

  await mkdir(outputDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    model: MODEL,
    size: SIZE,
    outputCount: OUTPUT_COUNT,
    expectedOrder: EXPECTED_IMAGES,
    runs: [],
  };

  let failure = null;
  for (let run = 1; run <= runCount; run += 1) {
    try {
      manifest.runs.push(await requestOneRun(apiKey, run, outputDir));
    } catch (error) {
      if (error?.partialResult) manifest.runs.push(error.partialResult);
      failure = error;
      break;
    }
  }

  await writeFile(path.join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(outputDir, 'review.html'), buildReviewHtml(manifest));
  const summary = buildSummary(manifest);
  await writeFile(path.join(outputDir, 'SUMMARY.md'), summary);

  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
  }

  if (failure) throw failure;
  console.log('Structural capture complete. Human visual review is still required.');
}

main().catch((error) => {
  const name = error?.name === 'TimeoutError' ? 'TimeoutError' : 'Error';
  console.error(`${name}: ${error?.message || 'Seedream contract probe failed.'}`);
  process.exitCode = 1;
});
