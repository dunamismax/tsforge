import { createFileRoute } from '@tanstack/react-router'
import { getServerSession } from '#/lib/auth'

export const Route = createFileRoute('/api/session')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const session = await getServerSession(request.headers)
        if (!session) {
          return Response.json({
            session: null,
            user: null,
          })
        }

        return Response.json({
          session: session.session,
          user: session.user,
        })
      },
    },
  },
})
