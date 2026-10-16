import { Auth, type Auth as AuthDef } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import type { RouteDefaultsInput } from "../route/client"
import { ProviderID, type ModelID } from "../schema"
import * as Gemini from "../protocols/gemini"

export const id = ProviderID.make("google-vertex")

export type Config = RouteDefaultsInput & {
  /** Google Cloud project used by the Vertex publisher-model endpoint. */
  readonly project: string
  /** Explicit Vertex region or multi-region; no ambient lookup or fallback is performed. */
  readonly location: string
  /** Auth is resolved by the caller; this provider never reads credentials or environment state. */
  readonly auth: AuthDef
}

const vertexHost = (location: string) => {
  if (location === "global") return "aiplatform.googleapis.com"
  if (location === "eu" || location === "us") return `aiplatform.${location}.rep.googleapis.com`
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(location))
    throw new Error("GoogleVertex.configure requires a lowercase Vertex location identifier")
  return `${location}-aiplatform.googleapis.com`
}

const configuredRoute = (input: Config) => {
  const { project, location, auth, ...defaults } = input
  if (!project.trim()) throw new Error("GoogleVertex.configure requires a non-empty project")
  if (!Auth.isAuth(auth)) throw new Error("GoogleVertex.configure requires caller-provided Auth")

  return Gemini.route.with({
    ...defaults,
    id: "google-vertex",
    provider: id,
    auth,
    endpoint: Endpoint.path(
      ({ request }) =>
        `/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(request.model.id)}:streamGenerateContent`,
      {
        baseURL: `https://${vertexHost(location)}/v1`,
        query: { alt: "sse" },
      },
    ),
  })
}

export const configure = (input: Config) => {
  const route = configuredRoute(input)
  return {
    id,
    model: (modelID: string | ModelID) => route.model({ id: modelID }),
    configure,
  }
}

export const provider = { id, configure }
