import { afterEach, describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { LayerNode } from "@horizoncode/core/effect/layer-node"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { eq } from "drizzle-orm"
import { ExperimentalPaths } from "../../src/server/routes/instance/httpapi/groups/experimental"
import { Session } from "@/session/session"
import { SessionTable } from "@horizoncode/core/session/sql"
import { Database } from "@horizoncode/core/database/database"
import { AccountV2 } from "@horizoncode/core/account"
import { AccountTable } from "@horizoncode/core/account/sql"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

const it = testEffect(Layer.mergeAll(LayerNode.compile(LayerNode.group([Session.node, Database.node])), httpApiLayer))
const testWorktreeMutations: typeof it.instance.skip =
  process.platform === "win32" ? it.instance.skip : it.instance

function request(path: string, directory: string, init: RequestInit = {}) {
  return requestInDirectory(path, directory, init)
}

function createSession(input?: Session.CreateInput) {
  return Session.use.create(input)
}

function json<T>(response: HttpClientResponse.HttpClientResponse) {
  return response.json.pipe(Effect.map((value) => value as T))
}

function worktreeMutationResponse(response: HttpClientResponse.HttpClientResponse) {
  return Effect.gen(function* () {
    return {
      status: response.status,
      body: yield* json<unknown>(response),
    }
  })
}

function insertAccount() {
  return Effect.acquireRelease(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(AccountTable)
        .values({
          id: AccountV2.ID.make("account-test"),
          email: "test@example.com",
          url: "https://console.example.com",
          access_token: AccountV2.AccessToken.make("access"),
          refresh_token: AccountV2.RefreshToken.make("refresh"),
          time_created: Date.now(),
          time_updated: Date.now(),
        })
        .run()
        .pipe(Effect.orDie)
      return "account-test"
    }),
    (id) =>
      Database.Service.use(({ db }) =>
        db
          .delete(AccountTable)
          .where(eq(AccountTable.id, AccountV2.ID.make(id)))
          .run()
          .pipe(Effect.orDie),
      ),
  )
}

function setSessionUpdated(session: Session.Info, updated: number) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .update(SessionTable)
      .set({ time_updated: updated })
      .where(eq(SessionTable.id, session.id))
      .run()
      .pipe(Effect.orDie)
  })
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("experimental HttpApi", () => {
  it.instance(
    "serves read-only experimental endpoints through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const directory = tmp.directory
        const [consoleState, consoleOrgs, toolList, toolIDs, worktrees, resources] = yield* Effect.all(
          [
            request(ExperimentalPaths.console, directory),
            request(ExperimentalPaths.consoleOrgs, directory),
            request(`${ExperimentalPaths.tool}?provider=opencode&model=gpt-5`, directory),
            request(ExperimentalPaths.toolIDs, directory),
            request(ExperimentalPaths.worktree, directory),
            request(ExperimentalPaths.resource, directory),
          ],
          { concurrency: "unbounded" },
        )

        expect(consoleState.status).toBe(200)
        expect(yield* json(consoleState)).toEqual({
          consoleManagedProviders: [],
          switchableOrgCount: 0,
        })

        expect(consoleOrgs.status).toBe(200)
        expect(yield* json(consoleOrgs)).toEqual({ orgs: [] })

        expect(toolList.status).toBe(200)
        expect(yield* json<unknown[]>(toolList)).toContainEqual(
          expect.objectContaining({
            id: "bash",
            description: expect.any(String),
            parameters: expect.any(Object),
          }),
        )

        expect(toolIDs.status).toBe(200)
        expect(yield* json(toolIDs)).toContain("bash")

        expect(worktrees.status).toBe(200)
        expect(yield* json(worktrees)).toEqual([])

        expect(resources.status).toBe(200)
        expect(yield* json(resources)).toEqual({})
      }),
    {
      config: {
        formatter: false,
        lsp: false,
        mcp: {
          demo: {
            type: "local",
            command: ["echo", "demo"],
            enabled: false,
          },
        },
      },
    },
  )

  it.instance("returns typed unavailability for worktree mutation requests on non-git projects", () =>
    Effect.gen(function* () {
      const tmp = yield* TestInstance
      const response = yield* request(ExperimentalPaths.worktree, tmp.directory, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })

      expect(yield* worktreeMutationResponse(response)).toMatchObject({
        status: 503,
        body: { _tag: "ServiceUnavailableError", service: "worktree" },
      })
    }),
  )

  it.instance(
    "serves Console org switch through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const accountID = yield* insertAccount()
        const switched = yield* request(ExperimentalPaths.consoleSwitch, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ accountID, orgID: "org-test" }),
        })

        expect(switched.status).toBe(200)
        expect(yield* json(switched)).toBe(true)
      }),
    { config: { formatter: false, lsp: false } },
  )

  it.instance(
    "serves global session list through the default server app",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const first = yield* createSession({ title: "page-one" })
        const second = yield* createSession({ title: "page-two" })
        yield* setSessionUpdated(first, 1)
        yield* setSessionUpdated(second, 2)

        const page = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({ directory: tmp.directory, limit: "1" })}`,
          tmp.directory,
        )
        expect(page.status).toBe(200)
        expect(page.headers["x-next-cursor"]).toBeTruthy()

        const body = yield* json<Session.GlobalInfo[]>(page)
        expect(body.map((session) => session.id)).toEqual([second.id])
        expect(body[0].project?.id).toBe(second.projectID)

        const next = yield* request(
          `${ExperimentalPaths.session}?${new URLSearchParams({
            directory: tmp.directory,
            limit: "10",
            cursor: body[0].time.updated.toString(),
          })}`,
          tmp.directory,
        )
        expect(next.status).toBe(200)
        expect((yield* json<Session.GlobalInfo[]>(next)).map((session) => session.id)).toContain(first.id)
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  testWorktreeMutations(
    "fails closed before creating a worktree",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const before = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(tmp.directory).quiet().text())
        const response = yield* request(ExperimentalPaths.worktree, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "route-mutation-disabled" }),
        })
        const result = yield* worktreeMutationResponse(response)
        if (typeof result.body === "object" && result.body !== null && "directory" in result.body) {
          const createdDirectory = String(result.body.directory)
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => $`git worktree remove --force ${createdDirectory}`.cwd(tmp.directory).quiet().nothrow()).pipe(
              Effect.ignore,
            ),
          )
        }

        const after = yield* Effect.promise(() => $`git worktree list --porcelain`.cwd(tmp.directory).quiet().text())
        expect({ ...result, after }).toMatchObject({
          status: 503,
          body: { _tag: "ServiceUnavailableError", service: "worktree" },
          after: before,
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  testWorktreeMutations(
    "fails closed before deleting an existing non-worktree directory",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const target = path.join(tmp.directory, "preserve-this-directory")
        const marker = path.join(target, "user-data.txt")
        yield* Effect.promise(async () => {
          await fs.mkdir(target)
          await fs.writeFile(marker, "preserve this user data")
        })

        const response = yield* request(ExperimentalPaths.worktree, tmp.directory, {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory: target }),
        })

        const markerContents = yield* Effect.promise(() => fs.readFile(marker, "utf8").catch(() => undefined))
        expect({ ...(yield* worktreeMutationResponse(response)), markerContents }).toMatchObject({
          status: 503,
          body: { _tag: "ServiceUnavailableError", service: "worktree" },
          markerContents: "preserve this user data",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  testWorktreeMutations(
    "fails closed before hard-resetting an existing worktree",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const directory = `${tmp.directory}-httpapi-reset`
        yield* Effect.promise(() => $`git worktree add --detach ${directory} HEAD`.cwd(tmp.directory).quiet())
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => $`git worktree remove --force ${directory}`.cwd(tmp.directory).quiet().nothrow()).pipe(
            Effect.ignore,
          ),
        )

        const marker = path.join(directory, "untracked-user-data.txt")
        yield* Effect.promise(() => fs.writeFile(marker, "preserve this untracked file"))
        const response = yield* request(ExperimentalPaths.worktreeReset, tmp.directory, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ directory }),
        })

        const markerContents = yield* Effect.promise(() => fs.readFile(marker, "utf8").catch(() => undefined))
        expect({ ...(yield* worktreeMutationResponse(response)), markerContents }).toMatchObject({
          status: 503,
          body: { _tag: "ServiceUnavailableError", service: "worktree" },
          markerContents: "preserve this untracked file",
        })
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
