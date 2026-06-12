export type PIIDetectionSource = 'regex' | 'ner';

export interface PIIEntity {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  confidence: number;
  source?: PIIDetectionSource;
}

export interface PIIPattern {
  type: string;
  pattern: RegExp;
  confidence: number;
}

export interface PIIToken {
  token: string;
  original: string;
  type: string;
  startIndex: number;
  endIndex: number;
  confidence: number;
}
