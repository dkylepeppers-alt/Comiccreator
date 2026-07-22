export function isComicReadOnly(comic: { referenceSchemaVersion?: number } | null | undefined): boolean {
  return Boolean(comic) && comic!.referenceSchemaVersion !== 2;
}

export function assertComicWritable(comic: { referenceSchemaVersion?: number } | null | undefined): void {
  if (isComicReadOnly(comic)) throw new Error('This comic is read-only');
}
