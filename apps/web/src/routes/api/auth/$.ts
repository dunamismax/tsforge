import { createFileRoute } from '@tanstack/react-router'
import { getAuth } from '#/lib/auth'

const missingAuthResponse = () =>
  Response.json(
    {
      error: 'Better Auth requires DATABASE_URL and BETTER_AUTH_SECRET.',
    },
    { status: 503 },
  )

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const auth = getAuth()
        return auth ? auth.handler(request) : missingAuthResponse()
      },
      POST: async ({ request }) => {
        const auth = getAuth()
        return auth ? auth.handler(request) : missingAuthResponse()
      },
    },
  },
})
