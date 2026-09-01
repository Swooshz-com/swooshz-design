declare module "react-test-renderer" {
  import type { ReactElement } from "react";

  export type ReactTestInstance = {
    props: Record<string, any>;
  };

  export type ReactTestRenderer = {
    root: {
      findAllByType(type: string): ReactTestInstance[];
      findAllByType(type: React.ElementType): ReactTestInstance[];
    };
    toJSON(): unknown;
    unmount(): void;
  };

  export function act(callback: () => void | Promise<void>): Promise<void>;
  export function create(element: ReactElement): ReactTestRenderer;
}
