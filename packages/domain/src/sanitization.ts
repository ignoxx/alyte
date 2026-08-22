/**
 * Sanitization recipes deliberately contain no PDF bytes. They are reversible editing intent
 * held beside an immutable Original Report until a native renderer creates a new artifact.
 * Coordinates are normalized to the unmodified source page (top-left origin).
 */

export type NormalizedRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type PageRotation = 0 | 90 | 180 | 270;
export type RedactionOrigin = 'suggested' | 'user';

export type RedactionRegion = {
  readonly id: string;
  readonly rect: NormalizedRect;
  readonly origin: RedactionOrigin;
  readonly label: string | null;
};

export type SanitizationPageRecipe = {
  readonly pageIndex: number;
  readonly selected: boolean;
  readonly crop: NormalizedRect | null;
  readonly rotation: PageRotation;
  readonly redactions: readonly RedactionRegion[];
};

export type SanitizationRecipe = {
  readonly schemaVersion: 1;
  readonly reportId: string;
  readonly pages: readonly SanitizationPageRecipe[];
};

export type SensitiveRegionSuggestion = {
  readonly id: string;
  readonly pageIndex: number;
  readonly rect: NormalizedRect;
  readonly label: string | null;
};

export function assertNormalizedRect(rect: NormalizedRect): void {
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y)) {
    throw new Error('Sanitization rectangle origin must be finite');
  }
  if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    throw new Error('Sanitization rectangle size must be finite');
  }
  if (rect.x < 0 || rect.y < 0 || rect.width <= 0 || rect.height <= 0) {
    throw new Error('Sanitization rectangle must have a positive in-bounds area');
  }
  if (rect.x + rect.width > 1 || rect.y + rect.height > 1) {
    throw new Error('Sanitization rectangle must stay within the source page');
  }
}

function cloneRect(rect: NormalizedRect): NormalizedRect {
  assertNormalizedRect(rect);
  return Object.freeze({ x: rect.x, y: rect.y, width: rect.width, height: rect.height });
}

export function normalizePageRotation(rotation: number): PageRotation {
  const normalized = ((rotation % 360) + 360) % 360;
  if (normalized !== 0 && normalized !== 90 && normalized !== 180 && normalized !== 270) {
    throw new Error('Sanitization rotation must be 0, 90, 180, or 270 degrees');
  }
  return normalized as PageRotation;
}

function cloneRegion(region: RedactionRegion): RedactionRegion {
  if (region.id.trim().length === 0) throw new Error('Redaction region id is required');
  if (region.origin !== 'suggested' && region.origin !== 'user') {
    throw new Error('Redaction region origin is invalid');
  }
  return Object.freeze({
    id: region.id,
    rect: cloneRect(region.rect),
    origin: region.origin,
    label: region.label ?? null,
  });
}

function clonePage(page: SanitizationPageRecipe): SanitizationPageRecipe {
  if (!Number.isInteger(page.pageIndex) || page.pageIndex < 0) {
    throw new Error('Sanitization page index must be a non-negative integer');
  }
  return Object.freeze({
    pageIndex: page.pageIndex,
    selected: page.selected,
    crop: page.crop === null ? null : cloneRect(page.crop),
    rotation: normalizePageRotation(page.rotation),
    redactions: Object.freeze(page.redactions.map(cloneRegion)),
  });
}

export function createSanitizationRecipe(
  reportId: string,
  pages: readonly SanitizationPageRecipe[],
): SanitizationRecipe {
  if (reportId.trim().length === 0) throw new Error('Sanitization report id is required');
  const clonedPages = pages.map(clonePage);
  const pageIndexes = new Set<number>();
  for (const page of clonedPages) {
    if (pageIndexes.has(page.pageIndex)) throw new Error('Sanitization pages must be unique');
    pageIndexes.add(page.pageIndex);
    const regionIds = new Set<string>();
    for (const region of page.redactions) {
      if (regionIds.has(region.id)) throw new Error('Redaction region ids must be unique per page');
      regionIds.add(region.id);
    }
  }
  return Object.freeze({ schemaVersion: 1, reportId, pages: Object.freeze(clonedPages) });
}

export function updateSanitizationPage(
  recipe: SanitizationRecipe,
  pageIndex: number,
  update: Partial<Pick<SanitizationPageRecipe, 'selected' | 'crop' | 'rotation'>>,
): SanitizationRecipe {
  const page = recipe.pages.find((candidate) => candidate.pageIndex === pageIndex);
  if (page === undefined) throw new Error(`Sanitization page ${pageIndex} was not found`);
  return createSanitizationRecipe(
    recipe.reportId,
    recipe.pages.map((candidate) =>
      candidate.pageIndex === pageIndex
        ? {
            ...candidate,
            ...(update.selected === undefined ? {} : { selected: update.selected }),
            ...(update.crop === undefined
              ? {}
              : { crop: update.crop === null ? null : cloneRect(update.crop) }),
            ...(update.rotation === undefined
              ? {}
              : { rotation: normalizePageRotation(update.rotation) }),
          }
        : candidate,
    ),
  );
}

/** Reordering is explicit and must be a complete permutation of the source pages. */
export function reorderSanitizationPages(
  recipe: SanitizationRecipe,
  orderedPageIndexes: readonly number[],
): SanitizationRecipe {
  if (orderedPageIndexes.length !== recipe.pages.length) {
    throw new Error('Sanitization page order must include every page exactly once');
  }
  const pages = new Map(recipe.pages.map((page) => [page.pageIndex, page]));
  const reordered: SanitizationPageRecipe[] = [];
  for (const pageIndex of orderedPageIndexes) {
    const page = pages.get(pageIndex);
    if (page === undefined || reordered.some((candidate) => candidate.pageIndex === pageIndex)) {
      throw new Error('Sanitization page order must be a permutation of the source pages');
    }
    reordered.push(page);
  }
  return createSanitizationRecipe(recipe.reportId, reordered);
}

export function addRedaction(
  recipe: SanitizationRecipe,
  pageIndex: number,
  region: RedactionRegion,
): SanitizationRecipe {
  const page = recipe.pages.find((candidate) => candidate.pageIndex === pageIndex);
  if (page === undefined) throw new Error(`Sanitization page ${pageIndex} was not found`);
  if (page.redactions.some((candidate) => candidate.id === region.id)) {
    throw new Error(`Redaction region ${region.id} already exists`);
  }
  return createSanitizationRecipe(
    recipe.reportId,
    recipe.pages.map((candidate) =>
      candidate.pageIndex === pageIndex
        ? { ...candidate, redactions: [...candidate.redactions, region] }
        : candidate,
    ),
  );
}

export function updateRedaction(
  recipe: SanitizationRecipe,
  pageIndex: number,
  regionId: string,
  rect: NormalizedRect,
): SanitizationRecipe {
  const page = recipe.pages.find((candidate) => candidate.pageIndex === pageIndex);
  if (page === undefined || !page.redactions.some((region) => region.id === regionId)) {
    throw new Error(`Redaction region ${regionId} was not found`);
  }
  return createSanitizationRecipe(
    recipe.reportId,
    recipe.pages.map((candidate) =>
      candidate.pageIndex === pageIndex
        ? {
            ...candidate,
            redactions: candidate.redactions.map((region) =>
              region.id === regionId ? { ...region, rect } : region,
            ),
          }
        : candidate,
    ),
  );
}

export function removeRedaction(
  recipe: SanitizationRecipe,
  pageIndex: number,
  regionId: string,
): SanitizationRecipe {
  const page = recipe.pages.find((candidate) => candidate.pageIndex === pageIndex);
  if (page === undefined || !page.redactions.some((region) => region.id === regionId)) {
    throw new Error(`Redaction region ${regionId} was not found`);
  }
  return createSanitizationRecipe(
    recipe.reportId,
    recipe.pages.map((candidate) =>
      candidate.pageIndex === pageIndex
        ? {
            ...candidate,
            redactions: candidate.redactions.filter((region) => region.id !== regionId),
          }
        : candidate,
    ),
  );
}

/** Transform a source-space rectangle into the cropped, rotated output page. */
export function transformRectForPage(
  rect: NormalizedRect,
  crop: NormalizedRect | null,
  rotation: PageRotation,
): NormalizedRect {
  assertNormalizedRect(rect);
  const area = crop ?? { x: 0, y: 0, width: 1, height: 1 };
  assertNormalizedRect(area);
  if (
    rect.x < area.x ||
    rect.y < area.y ||
    rect.x + rect.width > area.x + area.width ||
    rect.y + rect.height > area.y + area.height
  ) {
    throw new Error('Redaction must remain inside the selected crop');
  }
  const local = {
    x: (rect.x - area.x) / area.width,
    y: (rect.y - area.y) / area.height,
    width: rect.width / area.width,
    height: rect.height / area.height,
  };
  switch (rotation) {
    case 0:
      return cloneRect(local);
    case 90:
      return cloneRect({
        x: 1 - local.y - local.height,
        y: local.x,
        width: local.height,
        height: local.width,
      });
    case 180:
      return cloneRect({
        x: 1 - local.x - local.width,
        y: 1 - local.y - local.height,
        width: local.width,
        height: local.height,
      });
    case 270:
      return cloneRect({
        x: local.y,
        y: 1 - local.x - local.width,
        width: local.height,
        height: local.width,
      });
  }
}

/** Stable serialization is persisted with the derivative and makes regeneration auditable. */
export function serializeSanitizationRecipe(recipe: SanitizationRecipe): string {
  return JSON.stringify(recipe);
}

/** A compact deterministic recipe fingerprint; artifact bytes are hashed separately by native code. */
export function sanitizationRecipeHash(recipe: SanitizationRecipe): string {
  let hash = 2166136261;
  for (const character of serializeSanitizationRecipe(recipe)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `recipe-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}
