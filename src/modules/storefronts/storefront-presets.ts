// SF4 — the 75 landing-page mockups (originally static HTML files) consolidated into
// real, structured preset DATA: a palette extracted from each page's own :root CSS
// variables, one of 7 shared "mood" variants (bg/surface/card/text/muted/border/
// font tokens — dark, editorial, gradient, light, mono, retro, warm), and one of 2 real hero layout
// archetypes (hero-center, hero-split) actually used across those 75 pages.
//
// This is the "conversion honesty" the hardening spec calls for: 75 pages were never
// really 75 different layouts — they were 75 palettes crossed with a handful of
// reusable moods and two hero layouts. Storing that structure (not raw HTML) is what
// makes the storefront renderer able to render every one of these 75 looks through the
// exact same real code path a merchant's live storefront uses — see
// storefront-renderer/lib/storefrontPresets.ts, which must stay in sync with this file
// (no shared workspace package between backend/storefront-renderer/seller-panel yet;
// this is intentionally duplicated data, not divergent data).
//
// Storage shape on a Storefront's theme: { presetId, presetVersion, overrides } is the
// spec's target shape. What ships now additively stores presetId/presetVersion as theme
// lineage fields alongside the existing flat theme fields (see
// StorefrontThemeJson.presetId/presetVersion in storefronts.service.ts) rather than a
// full copy-on-write overrides diff — reworking the whole theme storage model to a pure
// diff is a larger, separate change; this still gets every hard requirement that matters
// today: real preset data (never raw HTML), versioned lineage, and a live-renderer
// preview using the same code path as production.

export type StorefrontPresetVariantName = "light" | "dark" | "warm" | "retro" | "mono" | "editorial" | "gradient";
export type StorefrontPresetHeroLayout = ["hero-center", "hero-split"][number];

export type StorefrontPresetVariant = {
  bg: string;
  surface: string;
  card: string;
  text: string;
  muted: string;
  border: string;
  fontHead: string;
  fontBody: string;
  backgroundImage?: "diagonal-primary-accent-tint";
};

export type StorefrontPresetPalette = {
  primaryColor: string;
  accentColor: string;
  inkColor: string;
};

export type StorefrontPreset = {
  presetId: string;
  presetVersion: number;
  label: string;
  variant: StorefrontPresetVariantName;
  heroLayout: StorefrontPresetHeroLayout;
  palette: StorefrontPresetPalette;
  heroTitle: string;
  heroSubtitle: string;
  ctaLabel: string;
  tags: string[];
};

export const STOREFRONT_PRESET_VARIANTS: Record<StorefrontPresetVariantName, StorefrontPresetVariant> = {
  light:
    {
      bg: "#ffffff",
      surface: "#f5f7fa",
      card: "#ffffff",
      text: "#0f172a",
      muted: "#5b6472",
      border: "rgba(15,23,42,.12)",
      fontHead: "ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif",
      fontBody: "ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif",
    },
  dark:
    {
      bg: "#0b0e14",
      surface: "#10141f",
      card: "#151b2b",
      text: "#eef2f8",
      muted: "#9aa4b3",
      border: "rgba(255,255,255,.12)",
      fontHead: "ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif",
      fontBody: "ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif",
    },
  warm:
    {
      bg: "#faf5ec",
      surface: "#f3ead9",
      card: "#fffdf7",
      text: "#33261a",
      muted: "#7d6b58",
      border: "rgba(15,23,42,.12)",
      fontHead: "ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif",
      fontBody: "ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif",
    },
  retro:
    {
      bg: "#f5eeda",
      surface: "#efe5c8",
      card: "#fffbef",
      text: "#232323",
      muted: "#5c5c5c",
      border: "#232323",
      fontHead: "ui-monospace,\"Cascadia Code\",Menlo,Consolas,\"Courier New\",monospace",
      fontBody: "ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif",
    },
  mono:
    {
      bg: "#0a0f0c",
      surface: "#0d1410",
      card: "#101a13",
      text: "#d7fbe8",
      muted: "#7fae94",
      border: "rgba(150,255,200,.2)",
      fontHead: "ui-monospace,\"Cascadia Code\",Menlo,Consolas,\"Courier New\",monospace",
      fontBody: "ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif",
    },
  editorial:
    {
      bg: "#ffffff",
      surface: "#f7f6f3",
      card: "#ffffff",
      text: "#111111",
      muted: "#555555",
      border: "#111111",
      fontHead: "ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif",
      fontBody: "ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif",
    },
  gradient:
    {
      bg: "#ffffff",
      surface: "#f5f7fa",
      card: "#ffffff",
      text: "#0f172a",
      muted: "#5b6472",
      border: "rgba(15,23,42,.12)",
      fontHead: "ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif",
      fontBody: "ui-sans-serif,system-ui,-apple-system,\"Segoe UI\",Roboto,Arial,sans-serif",
      backgroundImage: "diagonal-primary-accent-tint",
    }
};

export const STOREFRONT_PRESET_HERO_LAYOUTS: StorefrontPresetHeroLayout[] = ["hero-center", "hero-split"];

export const STOREFRONT_PRESETS: StorefrontPreset[] = [
  {
    presetId: "ai-agents",
    presetVersion: 1,
    label: "AI Agents",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#f97316", accentColor: "#facc15", inkColor: "#111827" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["ai", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "ai-app-builder",
    presetVersion: 1,
    label: "AI App Builder",
    variant: "gradient",
    heroLayout: "hero-center",
    palette: { primaryColor: "#ec4899", accentColor: "#8b5cf6", inkColor: "#ffffff" },
    heroTitle: "Vivid products, a vivid experience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Discover more",
    tags: ["ai", "layout:hero-center", "mood:gradient"]
  },
  {
    presetId: "ai-assistant",
    presetVersion: 1,
    label: "AI Assistant",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#d97757", accentColor: "#f59e0b", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["ai", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "ai-cloud",
    presetVersion: 1,
    label: "AI Cloud",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#0ea5e9", accentColor: "#8b5cf6", inkColor: "#ffffff" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["ai", "developer-tools", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "ai-code-editor",
    presetVersion: 1,
    label: "AI Code Editor",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#22d3ee", accentColor: "#8b5cf6", inkColor: "#052e16" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["ai", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "ai-coding-agent",
    presetVersion: 1,
    label: "AI Coding Agent",
    variant: "mono",
    heroLayout: "hero-center",
    palette: { primaryColor: "#fbbf24", accentColor: "#22d3ee", inkColor: "#111827" },
    heroTitle: "Precision-built for people who notice details",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "See the details",
    tags: ["ai", "layout:hero-center", "mood:mono"]
  },
  {
    presetId: "ai-integrations",
    presetVersion: 1,
    label: "AI Integrations",
    variant: "gradient",
    heroLayout: "hero-center",
    palette: { primaryColor: "#8b5cf6", accentColor: "#ec4899", inkColor: "#ffffff" },
    heroTitle: "Vivid products, a vivid experience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Discover more",
    tags: ["ai", "layout:hero-center", "mood:gradient"]
  },
  {
    presetId: "ai-model-hosting",
    presetVersion: 1,
    label: "AI Model Hosting",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#14b8a6", accentColor: "#22d3ee", inkColor: "#052e16" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["ai", "developer-tools", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "ai-video",
    presetVersion: 1,
    label: "AI Video",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#e879f9", accentColor: "#8b5cf6", inkColor: "#111827" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["ai", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "all-in-one-workspace",
    presetVersion: 1,
    label: "All In One Workspace",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#111827", accentColor: "#6b7280", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "analytics-database",
    presetVersion: 1,
    label: "Analytics Database",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#facc15", accentColor: "#f97316", inkColor: "#111827" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["developer-tools", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "appointment-scheduling",
    presetVersion: 1,
    label: "Appointment Scheduling",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#10b981", accentColor: "#0ea5e9", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "backend-platform",
    presetVersion: 1,
    label: "Backend Platform",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#3ecf8e", accentColor: "#0ea5e9", inkColor: "#052e16" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["developer-tools", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "cloud-infrastructure",
    presetVersion: 1,
    label: "Cloud Infrastructure",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#7b42bc", accentColor: "#22d3ee", inkColor: "#ffffff" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["developer-tools", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "coffee-shop",
    presetVersion: 1,
    label: "Coffee Shop",
    variant: "warm",
    heroLayout: "hero-split",
    palette: { primaryColor: "#6b3f23", accentColor: "#d9a066", inkColor: "#ffffff" },
    heroTitle: "Thoughtfully made, warmly presented",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Explore the range",
    tags: ["layout:hero-split", "lifestyle", "mood:warm"]
  },
  {
    presetId: "community-chat",
    presetVersion: 1,
    label: "Community Chat",
    variant: "gradient",
    heroLayout: "hero-center",
    palette: { primaryColor: "#6366f1", accentColor: "#a855f7", inkColor: "#ffffff" },
    heroTitle: "Vivid products, a vivid experience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Discover more",
    tags: ["business", "layout:hero-center", "mood:gradient"]
  },
  {
    presetId: "computer-hardware",
    presetVersion: 1,
    label: "Computer Hardware",
    variant: "light",
    heroLayout: "hero-split",
    palette: { primaryColor: "#0ea5e9", accentColor: "#6366f1", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-split", "mood:light"]
  },
  {
    presetId: "consumer-electronics",
    presetVersion: 1,
    label: "Consumer Electronics",
    variant: "light",
    heroLayout: "hero-split",
    palette: { primaryColor: "#111827", accentColor: "#6b7280", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-split", "mood:light"]
  },
  {
    presetId: "conversational-ai",
    presetVersion: 1,
    label: "Conversational AI",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#e4e4e7", accentColor: "#38bdf8", inkColor: "#111827" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["ai", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "crypto-exchange",
    presetVersion: 1,
    label: "Crypto Exchange",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#eab308", accentColor: "#f59e0b", inkColor: "#111827" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["crypto", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "crypto-investing",
    presetVersion: 1,
    label: "Crypto Investing",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#2563eb", accentColor: "#22c55e", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["crypto", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "customer-support",
    presetVersion: 1,
    label: "Customer Support",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#286efa", accentColor: "#22d3ee", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "design-collaboration",
    presetVersion: 1,
    label: "Design Collaboration",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#a259ff", accentColor: "#0acf83", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "developer-terminal",
    presetVersion: 1,
    label: "Developer Terminal",
    variant: "mono",
    heroLayout: "hero-center",
    palette: { primaryColor: "#4ade80", accentColor: "#22d3ee", inkColor: "#052e16" },
    heroTitle: "Precision-built for people who notice details",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "See the details",
    tags: ["business", "layout:hero-center", "mood:mono"]
  },
  {
    presetId: "digital-banking",
    presetVersion: 1,
    label: "Digital Banking",
    variant: "gradient",
    heroLayout: "hero-center",
    palette: { primaryColor: "#5f4bd8", accentColor: "#22d3ee", inkColor: "#ffffff" },
    heroTitle: "Vivid products, a vivid experience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Discover more",
    tags: ["fintech", "layout:hero-center", "mood:gradient"]
  },
  {
    presetId: "documentation-platform",
    presetVersion: 1,
    label: "Documentation Platform",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#16a34a", accentColor: "#22d3ee", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["developer-tools", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "ecommerce-platform",
    presetVersion: 1,
    label: "Ecommerce Platform",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#16a34a", accentColor: "#84cc16", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["developer-tools", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "electric-vehicles",
    presetVersion: 1,
    label: "Electric Vehicles",
    variant: "dark",
    heroLayout: "hero-split",
    palette: { primaryColor: "#22c55e", accentColor: "#0ea5e9", inkColor: "#052e16" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["automotive", "layout:hero-split", "mood:dark"]
  },
  {
    presetId: "email-api",
    presetVersion: 1,
    label: "Email Api",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#111827", accentColor: "#38bdf8", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["developer-tools", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "email-client",
    presetVersion: 1,
    label: "Email Client",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#6d28d9", accentColor: "#ec4899", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "enterprise-ai",
    presetVersion: 1,
    label: "Enterprise AI",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#3b82f6", accentColor: "#8b5cf6", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["ai", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "enterprise-technology",
    presetVersion: 1,
    label: "Enterprise Technology",
    variant: "editorial",
    heroLayout: "hero-center",
    palette: { primaryColor: "#1f70c1", accentColor: "#111827", inkColor: "#ffffff" },
    heroTitle: "The story behind every product",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Read more",
    tags: ["business", "layout:hero-center", "mood:editorial"]
  },
  {
    presetId: "error-monitoring",
    presetVersion: 1,
    label: "Error Monitoring",
    variant: "mono",
    heroLayout: "hero-center",
    palette: { primaryColor: "#a78bfa", accentColor: "#f472b6", inkColor: "#111827" },
    heroTitle: "Precision-built for people who notice details",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "See the details",
    tags: ["business", "layout:hero-center", "mood:mono"]
  },
  {
    presetId: "family-cars",
    presetVersion: 1,
    label: "Family Cars",
    variant: "warm",
    heroLayout: "hero-split",
    palette: { primaryColor: "#d97706", accentColor: "#f59e0b", inkColor: "#111827" },
    heroTitle: "Thoughtfully made, warmly presented",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Explore the range",
    tags: ["automotive", "layout:hero-split", "lifestyle", "mood:warm"]
  },
  {
    presetId: "frontend-hosting",
    presetVersion: 1,
    label: "Frontend Hosting",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#fafafa", accentColor: "#38bdf8", inkColor: "#111827" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["developer-tools", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "gaming-console",
    presetVersion: 1,
    label: "Gaming Console",
    variant: "dark",
    heroLayout: "hero-split",
    palette: { primaryColor: "#2563eb", accentColor: "#7c3aed", inkColor: "#ffffff" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["gaming", "layout:hero-split", "mood:dark"]
  },
  {
    presetId: "gpu-computing",
    presetVersion: 1,
    label: "GPU Computing",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#76b900", accentColor: "#22d3ee", inkColor: "#052e16" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["business", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "headless-cms",
    presetVersion: 1,
    label: "Headless CMS",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#f03e2f", accentColor: "#f59e0b", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "hypercars",
    presetVersion: 1,
    label: "Hypercars",
    variant: "dark",
    heroLayout: "hero-split",
    palette: { primaryColor: "#d90429", accentColor: "#111827", inkColor: "#ffffff" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["automotive", "layout:hero-split", "mood:dark"]
  },
  {
    presetId: "issue-tracking",
    presetVersion: 1,
    label: "Issue Tracking",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#5e6ad2", accentColor: "#26b5ce", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "local-ai",
    presetVersion: 1,
    label: "Local AI",
    variant: "mono",
    heroLayout: "hero-center",
    palette: { primaryColor: "#34d399", accentColor: "#22d3ee", inkColor: "#052e16" },
    heroTitle: "Precision-built for people who notice details",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "See the details",
    tags: ["ai", "layout:hero-center", "mood:mono"]
  },
  {
    presetId: "luxury-cars",
    presetVersion: 1,
    label: "Luxury Cars",
    variant: "dark",
    heroLayout: "hero-split",
    palette: { primaryColor: "#3b82f6", accentColor: "#94a3b8", inkColor: "#ffffff" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["automotive", "layout:hero-split", "mood:dark"]
  },
  {
    presetId: "mobile-app-development",
    presetVersion: 1,
    label: "Mobile App Development",
    variant: "gradient",
    heroLayout: "hero-center",
    palette: { primaryColor: "#0ea5e9", accentColor: "#8b5cf6", inkColor: "#ffffff" },
    heroTitle: "Vivid products, a vivid experience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Discover more",
    tags: ["business", "layout:hero-center", "mood:gradient"]
  },
  {
    presetId: "money-transfer",
    presetVersion: 1,
    label: "Money Transfer",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#65a30d", accentColor: "#16a34a", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["fintech", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "multimodal-ai",
    presetVersion: 1,
    label: "Multimodal AI",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#f43f5e", accentColor: "#8b5cf6", inkColor: "#ffffff" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["ai", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "music-streaming",
    presetVersion: 1,
    label: "Music Streaming",
    variant: "gradient",
    heroLayout: "hero-center",
    palette: { primaryColor: "#1db954", accentColor: "#0ea5e9", inkColor: "#052e16" },
    heroTitle: "Vivid products, a vivid experience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Discover more",
    tags: ["business", "layout:hero-center", "mood:gradient"]
  },
  {
    presetId: "no-code-database",
    presetVersion: 1,
    label: "No Code Database",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#d97706", accentColor: "#f59e0b", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["developer-tools", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "no-code-websites",
    presetVersion: 1,
    label: "No Code Websites",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#146ef5", accentColor: "#22d3ee", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "nosql-database",
    presetVersion: 1,
    label: "NOSQL Database",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#10b981", accentColor: "#22d3ee", inkColor: "#052e16" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["developer-tools", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "online-payments",
    presetVersion: 1,
    label: "Online Payments",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#635bff", accentColor: "#22d3ee", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["fintech", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "online-whiteboard",
    presetVersion: 1,
    label: "Online Whiteboard",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#f5c400", accentColor: "#3b82f6", inkColor: "#111827" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "open-source-ai",
    presetVersion: 1,
    label: "Open Source AI",
    variant: "mono",
    heroLayout: "hero-center",
    palette: { primaryColor: "#ff7000", accentColor: "#facc15", inkColor: "#111827" },
    heroTitle: "Precision-built for people who notice details",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "See the details",
    tags: ["ai", "layout:hero-center", "mood:mono"]
  },
  {
    presetId: "payment-network",
    presetVersion: 1,
    label: "Payment Network",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#eb5757", accentColor: "#f2994a", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["fintech", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "performance-cars",
    presetVersion: 1,
    label: "Performance Cars",
    variant: "dark",
    heroLayout: "hero-split",
    palette: { primaryColor: "#ef4444", accentColor: "#f97316", inkColor: "#ffffff" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["automotive", "layout:hero-split", "mood:dark"]
  },
  {
    presetId: "pro-crypto-trading",
    presetVersion: 1,
    label: "Pro Crypto Trading",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#8b5cf6", accentColor: "#22d3ee", inkColor: "#ffffff" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["crypto", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "product-analytics",
    presetVersion: 1,
    label: "Product Analytics",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#f54e00", accentColor: "#f9bd2b", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "productivity-launcher",
    presetVersion: 1,
    label: "Productivity Launcher",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#ff6363", accentColor: "#8b5cf6", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "retro-computers",
    presetVersion: 1,
    label: "Retro Computers",
    variant: "retro",
    heroLayout: "hero-split",
    palette: { primaryColor: "#1e3a8a", accentColor: "#0d9488", inkColor: "#ffffff" },
    heroTitle: "Classic style, done right",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Get yours",
    tags: ["layout:hero-split", "lifestyle", "mood:retro"]
  },
  {
    presetId: "retro-gaming",
    presetVersion: 1,
    label: "Retro Gaming",
    variant: "retro",
    heroLayout: "hero-split",
    palette: { primaryColor: "#9333ea", accentColor: "#f97316", inkColor: "#ffffff" },
    heroTitle: "Classic style, done right",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Get yours",
    tags: ["gaming", "layout:hero-split", "lifestyle", "mood:retro"]
  },
  {
    presetId: "ride-hailing",
    presetVersion: 1,
    label: "Ride Hailing",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#111111", accentColor: "#22c55e", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "sales-automation",
    presetVersion: 1,
    label: "Sales Automation",
    variant: "gradient",
    heroLayout: "hero-center",
    palette: { primaryColor: "#7c3aed", accentColor: "#ec4899", inkColor: "#ffffff" },
    heroTitle: "Vivid products, a vivid experience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Discover more",
    tags: ["business", "layout:hero-center", "mood:gradient"]
  },
  {
    presetId: "social-media",
    presetVersion: 1,
    label: "Social Media",
    variant: "gradient",
    heroLayout: "hero-center",
    palette: { primaryColor: "#0866ff", accentColor: "#ec4899", inkColor: "#ffffff" },
    heroTitle: "Vivid products, a vivid experience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Discover more",
    tags: ["business", "layout:hero-center", "mood:gradient"]
  },
  {
    presetId: "space-technology",
    presetVersion: 1,
    label: "Space Technology",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#38bdf8", accentColor: "#818cf8", inkColor: "#052e16" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["business", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "sports-cars",
    presetVersion: 1,
    label: "Sports Cars",
    variant: "dark",
    heroLayout: "hero-split",
    palette: { primaryColor: "#dc2626", accentColor: "#facc15", inkColor: "#ffffff" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["automotive", "layout:hero-split", "mood:dark"]
  },
  {
    presetId: "sportswear",
    presetVersion: 1,
    label: "Sportswear",
    variant: "light",
    heroLayout: "hero-split",
    palette: { primaryColor: "#111111", accentColor: "#f97316", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["layout:hero-split", "lifestyle", "mood:light"]
  },
  {
    presetId: "supercars",
    presetVersion: 1,
    label: "Supercars",
    variant: "dark",
    heroLayout: "hero-split",
    palette: { primaryColor: "#f59e0b", accentColor: "#dc2626", inkColor: "#111827" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["automotive", "layout:hero-split", "mood:dark"]
  },
  {
    presetId: "team-messaging",
    presetVersion: 1,
    label: "Team Messaging",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#4a154b", accentColor: "#36c5f0", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "tech-magazine",
    presetVersion: 1,
    label: "Tech Magazine",
    variant: "editorial",
    heroLayout: "hero-center",
    palette: { primaryColor: "#111111", accentColor: "#ff3b30", inkColor: "#ffffff" },
    heroTitle: "The story behind every product",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Read more",
    tags: ["business", "layout:hero-center", "mood:editorial"]
  },
  {
    presetId: "tech-news",
    presetVersion: 1,
    label: "Tech News",
    variant: "editorial",
    heroLayout: "hero-center",
    palette: { primaryColor: "#dc2680", accentColor: "#111827", inkColor: "#ffffff" },
    heroTitle: "The story behind every product",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Read more",
    tags: ["business", "layout:hero-center", "mood:editorial"]
  },
  {
    presetId: "telecom-services",
    presetVersion: 1,
    label: "Telecom Services",
    variant: "gradient",
    heroLayout: "hero-center",
    palette: { primaryColor: "#ef4444", accentColor: "#f97316", inkColor: "#ffffff" },
    heroTitle: "Vivid products, a vivid experience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Discover more",
    tags: ["business", "layout:hero-center", "mood:gradient"]
  },
  {
    presetId: "vacation-rentals",
    presetVersion: 1,
    label: "Vacation Rentals",
    variant: "warm",
    heroLayout: "hero-split",
    palette: { primaryColor: "#e05d44", accentColor: "#f59e0b", inkColor: "#ffffff" },
    heroTitle: "Thoughtfully made, warmly presented",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Explore the range",
    tags: ["layout:hero-split", "lifestyle", "mood:warm"]
  },
  {
    presetId: "visual-discovery",
    presetVersion: 1,
    label: "Visual Discovery",
    variant: "gradient",
    heroLayout: "hero-center",
    palette: { primaryColor: "#e60023", accentColor: "#f472b6", inkColor: "#ffffff" },
    heroTitle: "Vivid products, a vivid experience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Discover more",
    tags: ["business", "layout:hero-center", "mood:gradient"]
  },
  {
    presetId: "voice-ai",
    presetVersion: 1,
    label: "Voice AI",
    variant: "dark",
    heroLayout: "hero-center",
    palette: { primaryColor: "#a855f7", accentColor: "#ec4899", inkColor: "#ffffff" },
    heroTitle: "Bold products for a bold audience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop now",
    tags: ["ai", "layout:hero-center", "mood:dark"]
  },
  {
    presetId: "website-builder",
    presetVersion: 1,
    label: "Website Builder",
    variant: "light",
    heroLayout: "hero-center",
    palette: { primaryColor: "#0055ff", accentColor: "#00c6ff", inkColor: "#ffffff" },
    heroTitle: "Simple, focused, and easy to shop",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Shop the collection",
    tags: ["business", "layout:hero-center", "mood:light"]
  },
  {
    presetId: "workflow-automation",
    presetVersion: 1,
    label: "Workflow Automation",
    variant: "gradient",
    heroLayout: "hero-center",
    palette: { primaryColor: "#ff4f00", accentColor: "#f59e0b", inkColor: "#ffffff" },
    heroTitle: "Vivid products, a vivid experience",
    heroSubtitle: "Thoughtfully presented, shipped and delivered with Shipmastr checkout confidence.",
    ctaLabel: "Discover more",
    tags: ["business", "layout:hero-center", "mood:gradient"]
  }
];

const STOREFRONT_PRESETS_BY_ID = new Map(STOREFRONT_PRESETS.map((preset) => [preset.presetId, preset]));

export function findStorefrontPreset(presetId: string): StorefrontPreset | null {
  return STOREFRONT_PRESETS_BY_ID.get(presetId) || null;
}

export function isValidStorefrontPresetId(presetId: string): boolean {
  return STOREFRONT_PRESETS_BY_ID.has(presetId);
}

// Resolves a preset into the flat StorefrontThemeJson-compatible fields the renderer
// already understands (primaryColor/backgroundColor/textColor/fontFamily/heroLayout/
// heroTitle/heroSubtitle/ctaLabel/templateStyle) — this is the "preset defaults" half
// of "effective theme = preset defaults (+) overrides"; the seller-panel wizard applies
// a merchant's own edits (name/price/photos/headline) on top of this before saving.
export function resolveStorefrontPresetTheme(presetId: string) {
  const preset = findStorefrontPreset(presetId);
  if (!preset) return null;
  const variant = STOREFRONT_PRESET_VARIANTS[preset.variant];

  return {
    primaryColor: preset.palette.primaryColor,
    backgroundColor: variant.bg,
    textColor: variant.text,
    fontFamily: variant.fontBody,
    heroTitle: preset.heroTitle,
    heroSubtitle: preset.heroSubtitle,
    ctaLabel: preset.ctaLabel,
    ctaAction: "shipmastr_checkout" as const,
    templateStyle: preset.presetId,
    heroLayout: preset.heroLayout,
    presetId: preset.presetId,
    presetVersion: preset.presetVersion
  };
}
