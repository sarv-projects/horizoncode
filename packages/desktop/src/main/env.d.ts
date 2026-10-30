interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  export namespace Server {
    export const listen: typeof import("../../../horizoncode/dist/types/src/node").Server.listen
    export type Listener = import("../../../horizoncode/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../horizoncode/dist/types/src/node").Config.get
    export type Info = import("../../../horizoncode/dist/types/src/node").Config.Info
  }
  export const bootstrap: typeof import("../../../horizoncode/dist/types/src/node").bootstrap
}
