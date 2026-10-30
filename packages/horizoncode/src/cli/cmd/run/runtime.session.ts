export class SessionNotFoundError extends Error {
  constructor() {
    super("Session not found")
    this.name = "SessionNotFoundError"
  }
}

export async function requireSessionData<T>(request: Promise<{ data?: T; error?: unknown }>): Promise<T> {
  const response = await request
  if (response.error !== undefined) {
    throw response.error
  }
  if (response.data === undefined || response.data === null) {
    throw new SessionNotFoundError()
  }
  return response.data
}

export function requireSessionID<T extends { id?: string }>(session: T | undefined): string {
  if (!session?.id) {
    throw new SessionNotFoundError()
  }
  return session.id
}
