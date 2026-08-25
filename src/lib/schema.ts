import { AppError, type FieldError, type StructuredBriefData } from "./types";

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredObject(
  value: unknown,
  path: string,
  keys: readonly string[],
  errors: FieldError[],
): value is JsonObject {
  if (!isObject(value)) {
    errors.push({ field: path, code: "OBJECT_REQUIRED" });
    return false;
  }
  const expected = new Set(keys);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      errors.push({ field: `${path}.${key}`, code: "REQUIRED" });
    }
  }
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      errors.push({ field: `${path}.${key}`, code: "UNKNOWN_FIELD" });
    }
  }
  return true;
}

function stringValue(
  value: unknown,
  path: string,
  min: number,
  max: number,
  errors: FieldError[],
): value is string {
  if (typeof value !== "string") {
    errors.push({ field: path, code: "STRING_REQUIRED" });
    return false;
  }
  const length = Array.from(value).length;
  if (length < min || length > max) {
    errors.push({ field: path, code: "STRING_LENGTH" });
    return false;
  }
  return true;
}

function nullableString(
  value: unknown,
  path: string,
  max: number,
  errors: FieldError[],
): void {
  if (value === null) {
    return;
  }
  stringValue(value, path, 1, max, errors);
}

function booleanValue(value: unknown, path: string, errors: FieldError[]): value is boolean {
  if (typeof value !== "boolean") {
    errors.push({ field: path, code: "BOOLEAN_REQUIRED" });
    return false;
  }
  return value;
}

function arrayValue(value: unknown, path: string, max: number, errors: FieldError[]): value is unknown[] {
  if (!Array.isArray(value)) {
    errors.push({ field: path, code: "ARRAY_REQUIRED" });
    return false;
  }
  if (value.length > max) {
    errors.push({ field: path, code: "ARRAY_TOO_LARGE" });
  }
  return true;
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function validateProjectFacts(value: unknown, path: string, errors: FieldError[]): void {
  const keys = [
    "clientName",
    "eventName",
    "venueName",
    "eventLocation",
    "eventStartDate",
    "eventEndDate",
    "notes",
  ] as const;
  if (!requiredObject(value, path, keys, errors)) return;
  const object = value as JsonObject;
  nullableString(object.clientName, `${path}.clientName`, 200, errors);
  nullableString(object.eventName, `${path}.eventName`, 200, errors);
  nullableString(object.venueName, `${path}.venueName`, 200, errors);
  nullableString(object.eventLocation, `${path}.eventLocation`, 300, errors);
  for (const key of ["eventStartDate", "eventEndDate"] as const) {
    const item = object[key];
    if (item !== null && (typeof item !== "string" || !validIsoDate(item))) {
      errors.push({ field: `${path}.${key}`, code: "ISO_DATE_REQUIRED" });
    }
  }
  nullableString(object.notes, `${path}.notes`, 4000, errors);
}

function validateStringArray(
  value: unknown,
  path: string,
  maxItems: number,
  maxLength: number,
  errors: FieldError[],
): void {
  if (!arrayValue(value, path, maxItems, errors)) return;
  for (const [index, item] of value.entries()) {
    stringValue(item, `${path}[${index}]`, 1, maxLength, errors);
  }
}

function validateBrandStyle(value: unknown, path: string, errors: FieldError[]): void {
  const keys = [
    "brandName",
    "brandValues",
    "visualDirection",
    "preferredColors",
    "materials",
    "logoInstructions",
  ] as const;
  if (!requiredObject(value, path, keys, errors)) return;
  const object = value as JsonObject;
  nullableString(object.brandName, `${path}.brandName`, 200, errors);
  validateStringArray(object.brandValues, `${path}.brandValues`, 20, 200, errors);
  nullableString(object.visualDirection, `${path}.visualDirection`, 2000, errors);
  validateStringArray(object.preferredColors, `${path}.preferredColors`, 20, 100, errors);
  validateStringArray(object.materials, `${path}.materials`, 20, 100, errors);
  nullableString(object.logoInstructions, `${path}.logoInstructions`, 1000, errors);
}

function validateFunctionalRequirements(value: unknown, path: string, errors: FieldError[]): void {
  if (!arrayValue(value, path, 50, errors)) return;
  const keys = ["name", "count", "countIsExact", "mandatory", "details"] as const;
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!requiredObject(item, itemPath, keys, errors)) continue;
    const object = item as JsonObject;
    stringValue(object.name, `${itemPath}.name`, 1, 200, errors);
    if (object.count !== null &&
      (typeof object.count !== "number" || !Number.isInteger(object.count) || object.count < 0 || object.count > 1000)) {
      errors.push({ field: `${itemPath}.count`, code: "COUNT_INVALID" });
    }
    const exact = booleanValue(object.countIsExact, `${itemPath}.countIsExact`, errors);
    booleanValue(object.mandatory, `${itemPath}.mandatory`, errors);
    nullableString(object.details, `${itemPath}.details`, 2000, errors);
    if (object.count === null && exact === true) {
      errors.push({ field: `${itemPath}.countIsExact`, code: "COUNT_EXACT_REQUIRES_COUNT" });
    }
  }
}

function validateBudget(value: unknown, path: string, errors: FieldError[]): void {
  const keys = ["amount", "currency", "basis", "notes"] as const;
  if (!requiredObject(value, path, keys, errors)) return;
  const object = value as JsonObject;
  if (object.amount !== null &&
    (typeof object.amount !== "number" || !Number.isFinite(object.amount) || object.amount < 0)) {
    errors.push({ field: `${path}.amount`, code: "AMOUNT_INVALID" });
  }
  if (object.currency !== null &&
    (typeof object.currency !== "string" || !/^[A-Z]{3}$/.test(object.currency))) {
    errors.push({ field: `${path}.currency`, code: "CURRENCY_INVALID" });
  }
  if (object.basis !== null &&
    object.basis !== "total" && object.basis !== "per_sqm" && object.basis !== "unknown") {
    errors.push({ field: `${path}.basis`, code: "BASIS_INVALID" });
  }
  nullableString(object.notes, `${path}.notes`, 1000, errors);
}

function validateUnknowns(value: unknown, path: string, errors: FieldError[]): void {
  if (!arrayValue(value, path, 50, errors)) return;
  const keys = ["id", "field", "question", "critical", "resolution", "acceptedByUser"] as const;
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!requiredObject(item, itemPath, keys, errors)) continue;
    const object = item as JsonObject;
    stringValue(object.id, `${itemPath}.id`, 1, 80, errors);
    stringValue(object.field, `${itemPath}.field`, 1, 120, errors);
    stringValue(object.question, `${itemPath}.question`, 1, 1000, errors);
    booleanValue(object.critical, `${itemPath}.critical`, errors);
    nullableString(object.resolution, `${itemPath}.resolution`, 2000, errors);
    booleanValue(object.acceptedByUser, `${itemPath}.acceptedByUser`, errors);
  }
}

function validateAssumptions(
  value: unknown,
  path: string,
  errors: FieldError[],
  extraction: boolean,
): void {
  if (!arrayValue(value, path, 50, errors)) return;
  const keys = ["id", "field", "value", "source", "requiresConfirmation", "acceptedByUser"] as const;
  for (const [index, item] of value.entries()) {
    const itemPath = `${path}[${index}]`;
    if (!requiredObject(item, itemPath, keys, errors)) continue;
    const object = item as JsonObject;
    stringValue(object.id, `${itemPath}.id`, 1, 80, errors);
    stringValue(object.field, `${itemPath}.field`, 1, 120, errors);
    stringValue(object.value, `${itemPath}.value`, 1, 2000, errors);
    if (object.source !== "model" && object.source !== "user") {
      errors.push({ field: `${itemPath}.source`, code: "SOURCE_INVALID" });
    }
    booleanValue(object.requiresConfirmation, `${itemPath}.requiresConfirmation`, errors);
    const accepted = booleanValue(object.acceptedByUser, `${itemPath}.acceptedByUser`, errors);
    if (extraction && object.source === "model" && accepted === true) {
      errors.push({ field: `${itemPath}.acceptedByUser`, code: "MODEL_ASSUMPTION_NOT_ACCEPTED" });
    }
  }
}

function validateGeometryMentions(value: unknown, path: string, errors: FieldError[]): void {
  const keys = ["widthText", "depthText", "openSidesText", "maxHeightText"] as const;
  if (!requiredObject(value, path, keys, errors)) return;
  const object = value as JsonObject;
  for (const key of keys) {
    nullableString(object[key], `${path}.${key}`, 500, errors);
  }
}

export function briefValidationErrors(
  value: unknown,
  options: { extraction?: boolean } = {},
): FieldError[] {
  const errors: FieldError[] = [];
  const keys = [
    "projectFacts",
    "brandStyle",
    "functionalRequirements",
    "mandatoryRequirements",
    "prohibitedRequirements",
    "budget",
    "unknowns",
    "assumptions",
    "freeTextRequirements",
    "extractedGeometryMentions",
  ] as const;
  if (!requiredObject(value, "data", keys, errors)) return errors;
  const object = value as JsonObject;
  validateProjectFacts(object.projectFacts, "data.projectFacts", errors);
  validateBrandStyle(object.brandStyle, "data.brandStyle", errors);
  validateFunctionalRequirements(object.functionalRequirements, "data.functionalRequirements", errors);
  validateStringArray(object.mandatoryRequirements, "data.mandatoryRequirements", 50, 1000, errors);
  validateStringArray(object.prohibitedRequirements, "data.prohibitedRequirements", 50, 1000, errors);
  validateBudget(object.budget, "data.budget", errors);
  validateUnknowns(object.unknowns, "data.unknowns", errors);
  validateAssumptions(object.assumptions, "data.assumptions", errors, options.extraction === true);
  validateStringArray(object.freeTextRequirements, "data.freeTextRequirements", 50, 2000, errors);
  validateGeometryMentions(object.extractedGeometryMentions, "data.extractedGeometryMentions", errors);
  return errors;
}

export function assertBriefData(
  value: unknown,
  options: { extraction?: boolean } = {},
): asserts value is StructuredBriefData {
  const errors = briefValidationErrors(value, options);
  if (errors.length > 0) {
    throw new AppError(422, "INVALID_BRIEF_SCHEMA", errors.slice(0, 40));
  }
}

export function normalizeProviderBriefData(value: unknown): StructuredBriefData {
  const errors = briefValidationErrors(value);
  if (errors.length > 0) {
    throw new AppError(422, "INVALID_BRIEF_SCHEMA", errors.slice(0, 40));
  }
  const normalized = JSON.parse(JSON.stringify(value)) as StructuredBriefData;
  normalized.unknowns = normalized.unknowns.map((item) => ({
    ...item,
    acceptedByUser: false,
  }));
  normalized.assumptions = normalized.assumptions.map((item) => ({
    ...item,
    source: "model",
    acceptedByUser: false,
  }));
  assertBriefData(normalized, { extraction: true });
  return normalized;
}

export const BRIEF_V1_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "projectFacts",
    "brandStyle",
    "functionalRequirements",
    "mandatoryRequirements",
    "prohibitedRequirements",
    "budget",
    "unknowns",
    "assumptions",
    "freeTextRequirements",
    "extractedGeometryMentions",
  ],
  properties: {
    projectFacts: {
      type: "object",
      additionalProperties: false,
      required: ["clientName", "eventName", "venueName", "eventLocation", "eventStartDate", "eventEndDate", "notes"],
      properties: {
        clientName: { type: ["string", "null"], maxLength: 200 },
        eventName: { type: ["string", "null"], maxLength: 200 },
        venueName: { type: ["string", "null"], maxLength: 200 },
        eventLocation: { type: ["string", "null"], maxLength: 300 },
        eventStartDate: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        eventEndDate: { type: ["string", "null"], pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
        notes: { type: ["string", "null"], maxLength: 4000 },
      },
    },
    brandStyle: {
      type: "object",
      additionalProperties: false,
      required: ["brandName", "brandValues", "visualDirection", "preferredColors", "materials", "logoInstructions"],
      properties: {
        brandName: { type: ["string", "null"], maxLength: 200 },
        brandValues: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 200 } },
        visualDirection: { type: ["string", "null"], maxLength: 2000 },
        preferredColors: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 100 } },
        materials: { type: "array", maxItems: 20, items: { type: "string", minLength: 1, maxLength: 100 } },
        logoInstructions: { type: ["string", "null"], maxLength: 1000 },
      },
    },
    functionalRequirements: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "count", "countIsExact", "mandatory", "details"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 200 },
          count: { type: ["integer", "null"], minimum: 0, maximum: 1000 },
          countIsExact: { type: "boolean" },
          mandatory: { type: "boolean" },
          details: { type: ["string", "null"], maxLength: 2000 },
        },
      },
    },
    mandatoryRequirements: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 1000 } },
    prohibitedRequirements: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 1000 } },
    budget: {
      type: "object",
      additionalProperties: false,
      required: ["amount", "currency", "basis", "notes"],
      properties: {
        amount: { type: ["number", "null"], minimum: 0 },
        currency: { type: ["string", "null"], pattern: "^[A-Z]{3}$" },
        basis: { type: ["string", "null"], enum: ["total", "per_sqm", "unknown", null] },
        notes: { type: ["string", "null"], maxLength: 1000 },
      },
    },
    unknowns: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "field", "question", "critical", "resolution", "acceptedByUser"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 80 },
          field: { type: "string", minLength: 1, maxLength: 120 },
          question: { type: "string", minLength: 1, maxLength: 1000 },
          critical: { type: "boolean" },
          resolution: { type: ["string", "null"], maxLength: 2000 },
          acceptedByUser: { type: "boolean" },
        },
      },
    },
    assumptions: {
      type: "array",
      maxItems: 50,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "field", "value", "source", "requiresConfirmation", "acceptedByUser"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 80 },
          field: { type: "string", minLength: 1, maxLength: 120 },
          value: { type: "string", minLength: 1, maxLength: 2000 },
          source: { type: "string", enum: ["model", "user"] },
          requiresConfirmation: { type: "boolean" },
          acceptedByUser: { type: "boolean" },
        },
      },
    },
    freeTextRequirements: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 2000 } },
    extractedGeometryMentions: {
      type: "object",
      additionalProperties: false,
      required: ["widthText", "depthText", "openSidesText", "maxHeightText"],
      properties: {
        widthText: { type: ["string", "null"], maxLength: 500 },
        depthText: { type: ["string", "null"], maxLength: 500 },
        openSidesText: { type: ["string", "null"], maxLength: 500 },
        maxHeightText: { type: ["string", "null"], maxLength: 500 },
      },
    },
  },
} as const;
