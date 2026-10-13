export const sanitize = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, "_")

export * as McpCatalog from "./catalog"
