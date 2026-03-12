import type { QueryClient } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import {
  createRootRouteWithContext,
  HeadContent,
  Link,
  Outlet,
  Scripts,
} from '@tanstack/react-router'
import { TanStackRouterDevtools } from '@tanstack/react-router-devtools'
import appCss from '../styles.css?url'

export const Route = createRootRouteWithContext<{
  queryClient: QueryClient
}>()({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'tsforge | Bun-native Outlook template conversion' },
      {
        name: 'description',
        content:
          'Convert macOS .emltpl templates into Outlook .oft artifacts with Bun, Effect, TanStack Start, Drizzle, and Better Auth.',
      },
    ],
    links: [{ rel: 'stylesheet', href: appCss }],
  }),
  shellComponent: RootDocument,
  component: RootOutlet,
})

function RootOutlet() {
  return <Outlet />
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div className="app-shell">
          <header className="topbar">
            <div className="brand-lockup">
              <span className="brand-mark">ts</span>
              <div>
                <p className="eyebrow">Bun runtime + TanStack Start</p>
                <Link className="brand-name" to="/">
                  tsforge
                </Link>
              </div>
            </div>
            <nav className="topnav">
              <Link
                activeProps={{ className: 'topnav-link is-active' }}
                className="topnav-link"
                to="/"
              >
                Workbench
              </Link>
              <Link
                activeProps={{ className: 'topnav-link is-active' }}
                className="topnav-link"
                to="/login"
              >
                Auth
              </Link>
            </nav>
          </header>
          <main>{children}</main>
        </div>
        <TanStackRouterDevtools position="bottom-right" />
        <ReactQueryDevtools buttonPosition="bottom-left" />
        <Scripts />
      </body>
    </html>
  )
}
