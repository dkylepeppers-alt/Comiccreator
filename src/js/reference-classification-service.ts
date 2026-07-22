import DB from './db.js';
import { classifyCharacterReference } from './local-llm-classifier.js';
import { applyReferenceClassification } from './reference-metadata.js';
import type { CharacterReferenceImage } from './reference-metadata.js';

export async function classifyCharacterReferences(
  characterId: string,
  options: { reclassify?: boolean } = {},
): Promise<number> {
  const stored = await DB.get(DB.STORES.characters, characterId);
  if (!stored) return 0;
  const initial = DB.normalizeCharacterRecord(stored).record;
  const candidates = (initial.images || []).filter((image: CharacterReferenceImage) => {
    if (!image?.id || image.referenceMetadataSource === 'manual') return false;
    if (!options.reclassify && image.referenceMetadataSource === 'local') return false;
    return !!(image.description?.trim() || image.generationPrompt?.trim() || image.tag?.trim());
  });

  let updated = 0;
  for (const candidate of candidates) {
    const classification = await classifyCharacterReference({
      characterName: initial.name,
      characterAppearance: initial.appearance,
      imageDescription: candidate.description,
      generationPrompt: candidate.generationPrompt,
      legacyTag: candidate.tag,
    });
    if (!classification) continue;

    const latestStored = await DB.get(DB.STORES.characters, characterId);
    if (!latestStored) break;
    const latest = DB.normalizeCharacterRecord(latestStored).record;
    const current = latest.images?.find((image: CharacterReferenceImage) => image.id === candidate.id);
    if (!current || current.referenceMetadataSource === 'manual') continue;
    const result = applyReferenceClassification(latest, candidate.id, classification);
    if (result.changed) {
      result.record.updatedAt = Date.now();
      await DB.put(DB.STORES.characters, result.record);
      updated++;
    }
  }
  return updated;
}
