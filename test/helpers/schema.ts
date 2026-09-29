import { buildAnswerSchema } from "../../src/decision/openrouter.js";
import type { Question } from "../../src/decision/types.js";

/**
 * Thin typed wrapper over the adapter's schema builder, so the tests assert on the
 * real schema rather than on a reimplementation of it.
 */
export function buildAnswerSchemaForTest(questions: Record<string, Question>): TypedSchema {
  return buildAnswerSchema(questions) as unknown as TypedSchema;
}

interface FieldSchema {
  type?: string;
  enum?: string[];
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean;
  properties?: Record<string, FieldSchema>;
  required?: string[];
}

export interface TypedSchema {
  type: string;
  additionalProperties: boolean;
  properties: {
    answers: {
      type: string;
      additionalProperties: boolean;
      properties: Record<string, FieldSchema>;
      required: string[];
    };
  };
  required: string[];
}
