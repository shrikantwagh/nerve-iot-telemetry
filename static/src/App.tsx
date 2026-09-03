/**
 * Routes and the auth gate.
 *
 * HashRouter, not BrowserRouter: Xano static hosting documents no history-fallback
 * rewrite, so `/incidents/12` as a real path would 404 on refresh or a shared link.
 * Hash routing works on any static host with zero server config, which is the right
 * trade for deep links that must survive being pasted into a chat.
 */

import { Suspense, lazy } from 'react'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import { Layout } from './components/Layout'
import { Spinner } from './components/ui'
import { AuthProvider, useAuth } from './lib/auth'
import { useAsync } from './lib/useAsync'
import api from './lib/api'
import Login from './pages/Login'

// Split the route bundles so the login screen — the first thing an unauthenticated
// visitor loads — does not pay for Recharts.
const Overview = lazy(() => import('./pages/Overview'))
const Fleet = lazy(() => import('./pages/Fleet'))
const DeviceDetail = lazy(() => import('./pages/DeviceDetail'))
const Incidents = lazy(() => import('./pages/Incidents'))
const IncidentDetail = lazy(() => import('./pages/IncidentDetail'))
const Alerts = lazy(() => import('./pages/Alerts'))
const Rules = lazy(() => import('./pages/Rules'))
const Ask = lazy(() => import('./pages/Ask'))
const Predictions = lazy(() => import('./pages/Predictions'))
const Admin = lazy(() => import('./pages/Admin'))

function FullPageSpinner() {
  return (
    <div className="flex h-screen items-center justify-center" style={{ color: 'var(--text-muted)' }}>
      <Spinner size={24} />
    </div>
  )
}

/**
 * Badge counts for the sidebar. Kept here rather than in each page so the numbers are
 * consistent across navigation, and polled slowly — on a rate-limited instance an
 * eager badge poll is a self-inflicted outage.
 */
function AuthedApp() {
  const overview = useAsync((signal) => api.fleet.overview(signal), [], { pollMs: 60_000 })

  const counts = {
    incidents:
      overview.data?.open_incident_total ??
      (overview.data
        ? Object.values(overview.data.incident_counts ?? {}).reduce((a, b) => a + (b ?? 0), 0)
        : undefined),
    alerts:
      overview.data?.firing_alert_total ??
      (overview.data
        ? Object.values(overview.data.alert_counts ?? {}).reduce((a, b) => a + (b ?? 0), 0)
        : undefined),
  }

  return (
    <Layout counts={counts}>
      <Suspense
        fallback={
          <div className="flex justify-center py-16" style={{ color: 'var(--text-muted)' }}>
            <Spinner size={20} />
          </div>
        }
      >
        <Routes>
          <Route path="/" element={<Overview overview={overview} />} />
          <Route path="/fleet" element={<Fleet />} />
          <Route path="/devices/:deviceId" element={<DeviceDetail />} />
          <Route path="/incidents" element={<Incidents />} />
          <Route path="/incidents/:incidentId" element={<IncidentDetail />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/rules" element={<Rules />} />
          <Route path="/ask" element={<Ask />} />
          <Route path="/predictions" element={<Predictions />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </Layout>
  )
}

function Gate() {
  const { token, user, loading } = useAuth()

  // Wait for the initial token revalidation, so we never flash the login screen at
  // someone who is already signed in.
  if (loading) return <FullPageSpinner />
  if (!token || !user) return <Login />
  return <AuthedApp />
}

export default function App() {
  return (
    <AuthProvider>
      <HashRouter>
        <Gate />
      </HashRouter>
    </AuthProvider>
  )
}
