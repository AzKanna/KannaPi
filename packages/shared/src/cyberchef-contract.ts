export type CyberChefOperation =
  | "URL Decode"
  | "From Hex"
  | "From Base64"
  | "From Base64url"
  | "HTML Entity Decode"
  | "Unescape Unicode"
  | "Parse JSON String"
  | "JWT Decode";

export interface CyberChefRecipeStep {
  operation: CyberChefOperation;
  confidence: number;
  reason: string;
  inputPreview: string;
  outputPreview: string;
}

export interface CyberChefAlternative {
  operation: CyberChefOperation;
  confidence: number;
  reason: string;
  outputPreview: string;
}

export interface CyberChefDetectionResult {
  output: string;
  recipe: CyberChefRecipeStep[];
  alternatives: CyberChefAlternative[];
  confidence: number;
  warnings: string[];
  inputBytes: number;
  outputBytes: number;
}
