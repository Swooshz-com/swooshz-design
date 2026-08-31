import {
  s4DependencyMetadataReferenceHash,
  type S4DependencyMetadataReference,
  type S4DependencyMetadataReferenceInput,
} from "./s4-repository-audit";

const frozenReference: S4DependencyMetadataReferenceInput = {
  sourceSha: "3ff5676478cc6cab4aec4d1afe65bbb1c1c029ee",
  sourceTree: "ffa1d9e9f19bf563a6562aa8f4d94ac557ab4e77",
  packageEntries: [
    {
      locator: "react-is@19.2.8",
      value: {
        resolution: {
          integrity: "sha512-s5un28nYxKJw5gvUHyW5PCC28CvBqLu9r3cWgzHT4Vo/5fqqkFcdRYsGcKf50WMPpjjFZS5d76fn3YCo2njKwQ==",
        },
      },
    },
    {
      locator: "react-test-renderer@19.2.8",
      value: {
        resolution: {
          integrity: "sha512-GHKPaDRaNYU24PHTLG8Bx8VMY9t+qNfxQbt/Yjp7aMWBkKU6766SR0n6TnYu7P5I1MfEuAMUadqiyDHyI4Yy9Q==",
        },
        peerDependencies: {
          react: "^19.2.8",
        },
      },
    },
    {
      locator: "react@19.2.8",
      value: {
        resolution: {
          integrity: "sha512-PWaYA1L/q9u2u7xYQi+Y3L3Yfnie7XyLeaJICV1MGD6LprsBxcAqGjYyr0eY3p+QdsA+x/Irkt4Qif8D63+Sbw==",
        },
        engines: {
          node: ">=0.10.0",
        },
      },
    },
    {
      locator: "scheduler@0.27.0",
      value: {
        resolution: {
          integrity: "sha512-eNv+WrVbKu1f3vbYJT/xtiF5syA5HPIMtf9IgY/nKg0sWqzAUEvqY/xm7OcZc/qafLx/iO9FgOmeSAp4v5ti/Q==",
        },
      },
    },
  ],
  snapshotEntries: [
    {
      locator: "react-is@19.2.8",
      value: {},
    },
    {
      locator: "react-test-renderer@19.2.8(react@19.2.8)",
      value: {
        dependencies: {
          react: "19.2.8",
          "react-is": "19.2.8",
          scheduler: "0.27.0",
        },
      },
    },
    {
      locator: "react@19.2.8",
      value: {},
    },
    {
      locator: "scheduler@0.27.0",
      value: {},
    },
  ],
};

export const S4_G3_AUTHORIZED_DEPENDENCY_METADATA: S4DependencyMetadataReference = {
  ...frozenReference,
  metadataSha256: s4DependencyMetadataReferenceHash(frozenReference),
};
