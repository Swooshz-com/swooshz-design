import type { S4DependencyMetadataReference, S4DependencyAuthority } from "./s4-repository-audit";

const S5_PDF_PACKAGE_ENTRIES = [
  { locator: "@pdf-lib/fontkit@1.1.1", value: { resolution: { integrity: "sha512-KjMd7grNapIWS/Dm0gvfHEilSyAmeLvrEGVcqLGi0VYebuqqzTbgF29efCx7tvx+IEbG3zQciRSWl3GkUSvjZg==" } } },
  { locator: "@pdf-lib/standard-fonts@1.0.0", value: { resolution: { integrity: "sha512-hU30BK9IUN/su0Mn9VdlVKsWBS6GyhVfqjwl1FjZN4TxP6cCw0jP2w7V3Hf5uX7M0AZJ16vey9yE0ny7Sa59ZA==" } } },
  { locator: "@pdf-lib/upng@1.0.1", value: { resolution: { integrity: "sha512-dQK2FUMQtowVP00mtIksrlZhdFXQZPC+taih1q4CvPZ5vqdxR/LKBaFg0oAfzd1GlHZXXSPdQfzQnt+ViGvEIQ==" } } },
  { locator: "pako@1.0.11", value: { resolution: { integrity: "sha512-4hLB8Py4zZce5s4yd9XzopqwVv/yGNhV1Bl8NTmCq1763HeK2+EwVTv+leGeL13Dnh2wfbqowVPXCIO0z4taYw==" } } },
  { locator: "pdf-lib@1.17.1", value: { resolution: { integrity: "sha512-V/mpyJAoTsN4cnP31vc0wfNA1+p20evqqnap0KLoRUN0Yk/p3wN52DOEsL4oBFcLdb76hlpKPtzJIgo67j/XLw==" } } },
  { locator: "tslib@1.14.1", value: { resolution: { integrity: "sha512-Xni35NKzjgMrwevysHTCArtLDpPvye8zV/0E4EyYn43P7/7qvQwPh9BGkHewbMulVntbigmcT7rdX3BNo9wRJg==" } } },
] as const;

const S5_PDF_SNAPSHOT_ENTRIES = [
  { locator: "@pdf-lib/fontkit@1.1.1", value: { dependencies: { pako: "1.0.11" } } },
  { locator: "@pdf-lib/standard-fonts@1.0.0", value: { dependencies: { pako: "1.0.11" } } },
  { locator: "@pdf-lib/upng@1.0.1", value: { dependencies: { pako: "1.0.11" } } },
  { locator: "pako@1.0.11", value: {} },
  { locator: "pdf-lib@1.17.1", value: { dependencies: { "@pdf-lib/standard-fonts": "1.0.0", "@pdf-lib/upng": "1.0.1", pako: "1.0.11", tslib: "1.14.1" } } },
  { locator: "tslib@1.14.1", value: {} },
] as const;

export const S5_PDF_DEPENDENCY_METADATA: S4DependencyMetadataReference = {
  sourceSha: "e6c23e806b6c9ced339d04b0c91d6d71f42bbc40",
  sourceTree: "473fe31bfcb780f2f28c744b07475ba158bd4560",
  packageEntries: S5_PDF_PACKAGE_ENTRIES.map((entry) => ({ locator: entry.locator, value: entry.value })),
  snapshotEntries: S5_PDF_SNAPSHOT_ENTRIES.map((entry) => ({ locator: entry.locator, value: entry.value })),
  metadataSha256: "9aa76ecf7534f1b75a9e07c84b97c7842ea2325a898cd0f74f70c01d8ca2a4f6",
};

const common = {
  baseManifestValue: null,
  manifestPath: "dependencies" as const,
  purpose: "server-side deterministic S5 PDF presentation rendering only.",
  allowedImportSurface: ["src/lib/s5-pdf.ts"],
  authorityRefs: ["5487980459"],
  requiredAuthorityRef: "5487980459",
  baselineSha: "e6c23e806b6c9ced339d04b0c91d6d71f42bbc40",
  baselineTree: "473fe31bfcb780f2f28c744b07475ba158bd4560",
  expectedMetadata: S5_PDF_DEPENDENCY_METADATA,
};

export const S5_PDF_DEPENDENCIES: S4DependencyAuthority[] = [
  { ...common, packageName: "@pdf-lib/fontkit", packageVersion: "1.1.1" },
  { ...common, packageName: "pdf-lib", packageVersion: "1.17.1" },
];
