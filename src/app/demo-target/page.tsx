'use client'

/**
 * Demo target app — ProofPilot
 *
 * A safe local web application with intentionally introduced problems:
 *   - One broken link
 *   - One unlabeled form field
 *   - One horizontal overflow issue
 *   - One console error
 *   - One inaccessible button
 *   - One RTL layout issue
 *   - One mobile overlap
 *   - One successful form journey
 *
 * Mounted at /demo-target so the scanner can target it without
 * running a separate service. This is for ProofPilot's own QA —
 * its data is NEVER used as production findings.
 */
import Link from 'next/link'

export default function DemoTargetHome() {
  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b bg-white">
        <div className="mx-auto max-w-5xl px-4 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Demo Target</h1>
          <nav className="flex gap-4 text-sm">
            <Link href="/demo-target" className="text-blue-600 hover:underline">Home</Link>
            <Link href="/demo-target/contact" className="text-blue-600 hover:underline">Contact</Link>
            {/* Broken link — points to a non-existent page */}
            <Link href="/demo-target/nonexistent-page" className="text-blue-600 hover:underline">Broken Link</Link>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8 space-y-12">
        <section className="bg-white rounded-lg border p-6">
          <h2 className="text-lg font-semibold mb-2">Welcome</h2>
          <p className="text-slate-700">
            This is a deliberately broken demo target for ProofPilot scanner tests.
            Do not use its data as production findings.
          </p>
        </section>

        {/* Form with unlabeled field */}
        <section className="bg-white rounded-lg border p-6">
          <h2 className="text-lg font-semibold mb-4">Form with accessibility issues</h2>
          <form className="space-y-3">
            <input
              type="text"
              placeholder="Your name (no label)"
              className="w-full border rounded px-3 py-2"
            />
            <input
              type="email"
              placeholder="Your email (no label, no autocomplete)"
              className="w-full border rounded px-3 py-2"
            />
            <button
              type="submit"
              aria-label=""
              className="bg-slate-800 text-white px-4 py-2 rounded"
            >
              {/* empty text — screen readers will not announce this */}
            </button>
          </form>
        </section>

        {/* Horizontal overflow issue */}
        <section className="bg-white rounded-lg border p-6">
          <h2 className="text-lg font-semibold mb-4">Horizontal overflow</h2>
          <div className="whitespace-nowrap" style={{ minWidth: '1500px' }}>
            <p className="text-slate-700">
              This very wide content forces horizontal scroll on mobile, which is a layout defect
              the scanner should detect.
            </p>
          </div>
        </section>

        {/* Console error trigger */}
        <section className="bg-white rounded-lg border p-6">
          <h2 className="text-lg font-semibold mb-4">Console error trigger</h2>
          <button
            type="button"
            onClick={() => {
              console.error('ProofPilot demo: intentional console error for scanner test')
              try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ;(window as unknown as { undefinedVariable?: { deepProperty?: unknown } }).undefinedVariable?.deepProperty
              } catch (e) {
                console.error('ProofPilot demo: caught', e)
              }
            }}
            className="bg-amber-600 text-white px-4 py-2 rounded"
          >
            Trigger console error
          </button>
        </section>

        {/* Successful form journey */}
        <section className="bg-white rounded-lg border p-6">
          <h2 className="text-lg font-semibold mb-4">Successful form journey</h2>
          <form action="/demo-target/contact/success" method="get" className="space-y-3">
            <div>
              <label htmlFor="contact-name" className="block text-sm font-medium mb-1">Name</label>
              <input id="contact-name" name="name" type="text" required className="w-full border rounded px-3 py-2" />
            </div>
            <div>
              <label htmlFor="contact-email" className="block text-sm font-medium mb-1">Email</label>
              <input id="contact-email" name="email" type="email" autoComplete="email" required className="w-full border rounded px-3 py-2" />
            </div>
            <button type="submit" className="bg-blue-600 text-white px-4 py-2 rounded">Send</button>
          </form>
        </section>

        {/* Mobile overlap (fixed element covering content) */}
        <section className="bg-white rounded-lg border p-6 relative" style={{ minHeight: '200px' }}>
          <h2 className="text-lg font-semibold mb-4">Mobile overlap demo</h2>
          <p className="text-slate-700">
            Below on mobile screens, a fixed banner covers part of this content.
          </p>
          <div
            className="fixed bottom-0 left-0 right-0 bg-red-600 text-white p-4 z-50 md:hidden"
            style={{ pointerEvents: 'none' }}
          >
            Fixed banner overlapping content
          </div>
        </section>

        {/* RTL layout issue — element marked dir=rtl but layout still LTR */}
        <section className="bg-white rounded-lg border p-6" dir="rtl">
          <h2 className="text-lg font-semibold mb-4">RTL layout issue</h2>
          <div className="text-left" style={{ direction: 'ltr' }}>
            <p className="text-slate-700">This content is forced LTR inside an RTL container.</p>
          </div>
        </section>
      </main>

      <footer className="border-t bg-white mt-12">
        <div className="mx-auto max-w-5xl px-4 py-4 text-sm text-slate-500">
          ProofPilot demo target — for scanner QA only.
        </div>
      </footer>

      <script
        dangerouslySetInnerHTML={{
          __html: `window.addEventListener('load', function(){ console.error('ProofPilot demo: intentional load-time error'); });`,
        }}
      />
    </div>
  )
}
