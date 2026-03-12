import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

declare global {
  var __tsforgeSql: postgres.Sql | undefined
  var __tsforgeDb: ReturnType<typeof drizzle<typeof schema>> | undefined
}

const globalState = globalThis as typeof globalThis & {
  __tsforgeDb?: ReturnType<typeof drizzle<typeof schema>>
  __tsforgeSql?: postgres.Sql
}

export const isDatabaseConfigured = () => Boolean(process.env.DATABASE_URL)

export const getDb = () => {
  if (!process.env.DATABASE_URL) {
    return null
  }

  if (!globalState.__tsforgeSql) {
    globalState.__tsforgeSql = postgres(process.env.DATABASE_URL, {
      max: 1,
      prepare: false,
    })
  }

  if (!globalState.__tsforgeDb) {
    globalState.__tsforgeDb = drizzle(globalState.__tsforgeSql, {
      schema,
    })
  }

  return globalState.__tsforgeDb
}

export { schema }
export type Database = NonNullable<ReturnType<typeof getDb>>
