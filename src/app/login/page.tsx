'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Loader2 } from 'lucide-react'
import { OAuthButtons } from '@/components/auth/oauth-buttons'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [csrfToken, setCsrfToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Surface OAuth callback errors (e.g. user denied consent, state invalid).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const err = params.get('error')
    if (err) {
      const provider = params.get('provider') ?? 'provider'
      const messages: Record<string, string> = {
        provider_error: `${provider} did not authorize the request. Please try again.`,
        missing_code_or_state: 'The OAuth callback was missing required parameters. Please try again.',
        invalid_state: 'The OAuth state token was invalid or expired. Please try again.',
        account_conflict: 'This provider account is already linked to another ProofPilot user.',
        account_suspended: 'This account is suspended or deleted.',
        email_not_verified: 'The provider did not return a verified email address.',
        not_configured: 'This sign-in method is not configured on the server.',
        unknown_provider: 'Unknown sign-in provider.',
        internal_error: 'An unexpected error occurred during sign-in. Please try again.',
      }
      setError(messages[err] ?? `Sign-in failed: ${err}`)
      // Clean the URL so the error doesn't persist on refresh.
      window.history.replaceState({}, '', '/login')
    }
  }, [])

  useEffect(() => {
    fetch('/api/v1/csrf').then(r => r.json()).then(d => setCsrfToken(d.csrfToken))
  }, [])

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrfToken,
        },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.detail || data.title || 'Login failed')
        return
      }
      if (data.requiresMfa) {
        router.push('/app')
      } else {
        router.push('/app')
      }
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Sign in to ProofPilot</CardTitle>
          <CardDescription>Enter your credentials to access your dashboard.</CardDescription>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <OAuthButtons redirectTarget="/app" />
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                disabled={loading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
                disabled={loading}
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-3">
            <Button type="submit" className="w-full" disabled={loading || !csrfToken}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Sign in
            </Button>
            <div className="text-sm text-muted-foreground text-center w-full">
              Don&apos;t have an account?{' '}
              <Link href="/register" className="text-primary hover:underline">Register</Link>
            </div>
            <div className="text-sm text-muted-foreground text-center w-full">
              <Link href="/forgot-password" className="hover:underline">Forgot password?</Link>
            </div>
          </CardFooter>
        </form>
      </Card>
    </div>
  )
}
