/// <reference types="vite/client" />

/** @hpcc-js/wasm types for `./graphviz` re-export a devDep not installed here */
declare module "@hpcc-js/wasm/graphviz" {
  export class Graphviz {
    static load(): Promise<Graphviz>;
    layout(dot: string, format: string, engine: string, ...rest: unknown[]): string;
  }
}
