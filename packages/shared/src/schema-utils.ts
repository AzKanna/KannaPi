import { Type, type TUnsafe } from "typebox";

/**
 * String enum schema as plain JSON-Schema `enum` (NOT Union/Literal — those break
 * Google's API). Same approach as pi-ai's StringEnum; kept local so @kanna/shared
 * does not depend on @earendil-works/* (ADR-001: only @kanna/agent touches Pi).
 */
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    ...(options?.description && { description: options.description }),
    ...(options?.default !== undefined && { default: options.default }),
  });
}
