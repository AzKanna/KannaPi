import type {
  CookieSummary,
  Endpoint,
  FindingCategory,
  ParameterIndex,
  Severity,
  TechnologyFingerprint,
} from "./types.js";

export interface PassiveReconHost {
  host: string;
  ports: number[];
  schemes: string[];
  methods: string[];
  contentTypes: string[];
  statusCodes: number[];
  flowCount: number;
  firstSeen: number;
  lastSeen: number;
}

export interface PassiveReconSignal {
  key: string;
  moduleId: string;
  category: FindingCategory;
  title: string;
  detail: string;
  severity: Severity;
  count: number;
  hosts: string[];
  flowIds: string[];
  firstSeen: number;
  lastSeen: number;
}

export interface PassiveReconDistribution {
  name: string;
  count: number;
}

export interface PassiveReconReport {
  sessionId: string;
  target?: string;
  generatedAt: number;
  totalFlows: number;
  analyzedFlows: number;
  truncated: boolean;
  responseFlows: number;
  totalRequestBytes: number;
  totalResponseBytes: number;
  hosts: PassiveReconHost[];
  endpoints: Endpoint[];
  parameters: ParameterIndex[];
  cookies: CookieSummary[];
  technologies: TechnologyFingerprint[];
  signals: PassiveReconSignal[];
  methods: PassiveReconDistribution[];
  statuses: PassiveReconDistribution[];
  contentTypes: PassiveReconDistribution[];
}
