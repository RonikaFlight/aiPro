import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Navbar } from "@/components/landing/Navbar"
import { Footer } from "@/components/landing/Footer"
import {
  Globe,
  Play,
  FileText,
  Accessibility,
  MonitorSmartphone,
  Languages,
  TerminalSquare,
  ShieldCheck,
  Route,
  Sparkles,
  FileBarChart,
  Building2,
  Bot,
  Bug,
  ArrowRight,
  Lock,
  Shield,
  KeyRound,
  ClipboardCheck,
} from "lucide-react"

const LOGOS = ["Agency Pro", "FreelanceQA", "AI Builders Co.", "StartupHub"] as const

const STEPS = [
  {
    icon: Globe,
    title: "Add your URL",
    description:
      "Verify your domain and add your application URL. We support staging, preview, and production environments.",
  },
  {
    icon: Play,
    title: "Run automated checks",
    description:
      "ProofPilot crawls your pages, runs browser-based checks, tests responsiveness, accessibility, and localization.",
  },
  {
    icon: FileText,
    title: "Get delivery-ready reports",
    description:
      "Review findings with severity, business impact, and AI-powered explanations. Share client-friendly reports.",
  },
] as const

const FEATURES = [
  {
    icon: Accessibility,
    title: "Accessibility Auditing",
    description:
      "WCAG compliance, screen reader checks, color contrast, keyboard navigation.",
  },
  {
    icon: MonitorSmartphone,
    title: "Responsive Testing",
    description:
      "Tests across viewport breakpoints, detects horizontal overflow, layout shifts.",
  },
  {
    icon: Languages,
    title: "RTL & Localization",
    description:
      "Bidirectional layout checks, mixed-direction text, locale-specific formatters.",
  },
  {
    icon: TerminalSquare,
    title: "Runtime Error Detection",
    description:
      "Captures console errors, unhandled rejections, network failures.",
  },
  {
    icon: ShieldCheck,
    title: "Passive Security",
    description:
      "HTTPS, mixed content, CSP headers, cookie flags, form autocomplete.",
  },
  {
    icon: Route,
    title: "User Journey Testing",
    description:
      "Record and replay critical user flows, detect broken interactions.",
  },
  {
    icon: Sparkles,
    title: "AI-Powered Analysis",
    description:
      "Automatic explanations, business impact scoring, remediation suggestions.",
  },
  {
    icon: FileBarChart,
    title: "Client-Ready Reports",
    description:
      "White-label, PDF export, secure sharing, delivery readiness scores.",
  },
] as const

const TEAMS = [
  {
    icon: Building2,
    title: "Web Agencies",
    description:
      "Deliver projects with confidence. Show clients you caught every issue before launch.",
  },
  {
    icon: Bot,
    title: "AI-App Builders",
    description:
      "AI generates fast, but introduces unique bugs. ProofPilot catches what code review misses.",
  },
  {
    icon: Bug,
    title: "QA Engineers",
    description:
      "Amplify your team. Automated regression testing with evidence-based reporting.",
  },
] as const

const PRICING = [
  {
    name: "Free",
    price: "$0/month",
    description: "5 pages, 1 project, basic checks",
    cta: "Get started",
    href: "/register",
    popular: false,
  },
  {
    name: "Pro",
    price: "$49/month",
    description: "50 pages, 10 projects, AI insights, PDF export",
    cta: "Start free trial",
    href: "/register",
    popular: true,
  },
  {
    name: "Agency",
    price: "$199/month",
    description: "Unlimited pages & projects, white-label, priority support",
    cta: "Contact sales",
    href: "/contact",
    popular: false,
  },
] as const

const SECURITY_POINTS = [
  {
    icon: Shield,
    title: "SSRF Protection",
    description: "Protects against private network scanning",
  },
  {
    icon: Lock,
    title: "DNS Rebinding Defense",
    description: "Prevents bypass attacks",
  },
  {
    icon: KeyRound,
    title: "Encrypted Secrets",
    description: "AES-256-GCM for project credentials",
  },
  {
    icon: ClipboardCheck,
    title: "Audit Trail",
    description: "Every action logged and reviewable",
  },
] as const

export default function Home() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Navbar />

      <main className="flex-1">
        {/* Hero */}
        <section className="py-24 sm:py-32">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
            <Badge
              variant="secondary"
              className="mb-6 px-4 py-1.5 text-sm rounded-full"
            >
              Ship AI-built apps with evidence, not hope
            </Badge>

            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight mb-6">
              Automated QA for{" "}
              <span className="text-primary">AI-Built Web Apps</span>
            </h1>

            <p className="mx-auto max-w-2xl text-lg text-muted-foreground mb-10">
              Enter a URL. ProofPilot discovers pages, runs real browser checks,
              detects accessibility, responsive, RTL, and runtime problems — then
              produces client-ready delivery reports.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Button size="lg" asChild>
                <Link href="/register">Start free scan</Link>
              </Button>
              <Button variant="outline" size="lg" asChild>
                <Link href="/demo-target">View demo</Link>
              </Button>
            </div>

            <p className="mt-6 text-xs text-muted-foreground">
              No credit card required &middot; 5-page free scans &middot; SOC 2 compliant
            </p>
          </div>
        </section>

        {/* Social proof logos */}
        <section className="border-y bg-muted/30 py-10">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <p className="text-center text-sm text-muted-foreground mb-6">
              Trusted by web agencies, freelancers, and AI-app builders worldwide
            </p>
            <div className="flex flex-wrap items-center justify-center gap-4">
              {LOGOS.map((name) => (
                <span
                  key={name}
                  className="rounded-lg border bg-card px-5 py-2.5 text-sm font-medium text-muted-foreground"
                >
                  {name}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* How It Works */}
        <section className="py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-14">
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
                How It Works
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto">
                Three simple steps from URL to delivery-ready report.
              </p>
            </div>

            <div className="grid md:grid-cols-3 gap-8">
              {STEPS.map((step, i) => {
                const Icon = step.icon
                return (
                  <div
                    key={step.title}
                    className="relative flex flex-col items-center text-center"
                  >
                    <div className="relative mb-4">
                      <div className="flex size-14 items-center justify-center rounded-xl bg-primary/10 text-primary">
                        <Icon className="size-6" />
                      </div>
                      <span className="absolute -top-2 -right-2 flex size-6 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold">
                        {i + 1}
                      </span>
                    </div>
                    <h3 className="text-lg font-semibold mb-2">{step.title}</h3>
                    <p className="text-sm text-muted-foreground max-w-xs">
                      {step.description}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        {/* Features Grid */}
        <section id="features" className="py-20 sm:py-24 bg-muted/30">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-14">
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
                Everything You Need to Ship with Confidence
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto">
                Comprehensive automated checks that cover every aspect of web app quality.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {FEATURES.map((feature) => {
                const Icon = feature.icon
                return (
                  <div
                    key={feature.title}
                    className="rounded-xl border bg-card p-6 hover:shadow-md transition-shadow"
                  >
                    <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-5" />
                    </div>
                    <h3 className="font-semibold mb-1.5">{feature.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {feature.description}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        {/* For Different Teams */}
        <section className="py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-14">
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
                Built for Every Team
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto">
                Whether you ship one site a month or fifty, ProofPilot scales with you.
              </p>
            </div>

            <div className="grid md:grid-cols-3 gap-8">
              {TEAMS.map((team) => {
                const Icon = team.icon
                return (
                  <div
                    key={team.title}
                    className="rounded-xl border bg-card p-6 hover:shadow-md transition-shadow text-center"
                  >
                    <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Icon className="size-6" />
                    </div>
                    <h3 className="text-lg font-semibold mb-2">{team.title}</h3>
                    <p className="text-sm text-muted-foreground leading-relaxed">
                      {team.description}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="py-20 sm:py-24 bg-muted/30">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-14">
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
                Simple, Transparent Pricing
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto">
                Start free and scale as you grow. No surprises.
              </p>
            </div>

            <div className="grid md:grid-cols-3 gap-8 max-w-4xl mx-auto">
              {PRICING.map((plan) => (
                <div
                  key={plan.name}
                  className={"relative rounded-xl border bg-card p-6 flex flex-col hover:shadow-md transition-shadow" + (plan.popular ? " ring-2 ring-primary" : "")}
                >
                  {plan.popular && (
                    <Badge className="absolute -top-3 left-1/2 -translate-x-1/2">
                      Popular
                    </Badge>
                  )}
                  <h3 className="text-lg font-semibold mb-1">{plan.name}</h3>
                  <p className="text-2xl font-bold mb-2">{plan.price}</p>
                  <p className="text-sm text-muted-foreground mb-6">
                    {plan.description}
                  </p>
                  <div className="mt-auto">
                    <Button
                      variant={plan.popular ? "default" : "outline"}
                      className="w-full"
                      asChild
                    >
                      <Link href={plan.href}>
                        {plan.cta}
                        <ArrowRight className="size-4" />
                      </Link>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Security Trust */}
        <section id="security" className="py-20 sm:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="text-center mb-14">
              <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <ShieldCheck className="size-7" />
              </div>
              <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">
                Security-First Architecture
              </h2>
              <p className="text-muted-foreground max-w-xl mx-auto">
                Your data and your clients’ data are protected at every layer.
              </p>
            </div>

            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
              {SECURITY_POINTS.map((point) => {
                const Icon = point.icon
                return (
                  <div
                    key={point.title}
                    className="rounded-xl border bg-card p-6 hover:shadow-md transition-shadow"
                  >
                    <div className="mb-4 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                      <Icon className="size-5" />
                    </div>
                    <h3 className="font-semibold mb-1.5">{point.title}</h3>
                    <p className="text-sm text-muted-foreground">
                      {point.description}
                    </p>
                  </div>
                )
              })}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-20 sm:py-24 bg-primary/5">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 text-center">
            <h2 className="text-3xl sm:text-4xl font-bold tracking-tight mb-4">
              Ready to Ship with Confidence?
            </h2>
            <p className="text-muted-foreground max-w-lg mx-auto mb-8">
              Start your first scan in under 2 minutes. No credit card required.
            </p>
            <Button size="lg" asChild>
              <Link href="/register">
                Start free scan
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </section>
      </main>

      <Footer />
    </div>
  )
}
