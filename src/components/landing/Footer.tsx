import Link from "next/link"
import { ShieldCheck } from "lucide-react"

const FOOTER_SECTIONS = [
  {
    title: "Product",
    links: [
      { label: "Features", href: "#features" },
      { label: "Pricing", href: "#pricing" },
      { label: "Security", href: "#security" },
      { label: "Docs", href: "/docs" },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "About", href: "/about" },
      { label: "Contact", href: "/contact" },
      { label: "Blog", href: "/blog" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "/terms" },
      { label: "Privacy", href: "/privacy" },
    ],
  },
  {
    title: "Connect",
    links: [
      { label: "Twitter", href: "https://twitter.com/proofpilot" },
      { label: "GitHub", href: "https://github.com/proofpilot" },
      { label: "Discord", href: "https://discord.gg/proofpilot" },
    ],
  },
] as const

export function Footer() {
  return (
    <footer className="mt-auto border-t bg-card">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 py-12">
          {FOOTER_SECTIONS.map((section) => (
            <div key={section.title}>
              <h3 className="text-sm font-semibold mb-3">{section.title}</h3>
              <ul className="space-y-2">
                {section.links.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <div className="border-t py-6 flex flex-col sm:flex-row items-center justify-between gap-2 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <ShieldCheck className="size-4 text-primary" />
            <span>&copy; 2025 ProofPilot</span>
          </div>
          <p className="text-xs">Automated QA, not penetration testing.</p>
        </div>
      </div>
    </footer>
  )
}
