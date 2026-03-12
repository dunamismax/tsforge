import { getDb, schema } from '@tsforge/db'
import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'

export const getAuth = () => {
  const db = getDb()
  const secret = process.env.BETTER_AUTH_SECRET

  if (!db || !secret) {
    return null
  }

  return betterAuth({
    appName: 'tsforge',
    baseURL: process.env.BETTER_AUTH_URL,
    secret,
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema,
    }),
    emailAndPassword: {
      autoSignIn: true,
      enabled: true,
    },
  })
}

export const getServerSession = async (headers: Headers) => {
  const auth = getAuth()
  if (!auth) {
    return null
  }
  return auth.api.getSession({
    headers,
  })
}
