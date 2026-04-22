// ── Engine definitions ────────────────────────────────────────────

export type EngineStatus = 'active' | 'development' | 'scheduled';

export interface Engine {
  id:          string;
  name:        string;
  codename:    string;
  purpose:     string;
  description: string;
  status:      EngineStatus;
  statusLabel: string;
  href?:       string;
  capabilities: string[];
}

export const ENGINES: Engine[] = [
  {
    id:          'intelligence',
    name:        'Intelligence Engine',
    codename:    'Module I',
    purpose:     'Market intelligence, signal generation, and institutional-grade decision support.',
    description: 'The core of Quantorus365. Delivers real-time market intelligence across NSE/BSE equities — integrating multi-factor scoring, scenario detection, rejection discipline, and portfolio-aware signal generation.',
    status:      'active',
    statusLabel: 'Active Module',
    href:        `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/login`,
    capabilities: [
      'Real-time signal generation with 11-gate rejection engine',
      'Scenario-driven strategy selection',
      'Portfolio fit scoring and sector exposure awareness',
      'Multi-factor confidence model (9 independent components)',
      'Market stance detection: Aggressive → Capital Preservation',
    ],
  },
  {
    id:          'risk',
    name:        'Risk Intelligence Engine',
    codename:    'Module II',
    purpose:     'Portfolio risk quantification, drawdown management, and dynamic position sizing.',
    description: 'A dedicated risk layer designed to sit beneath all trading decisions. Computes real-time portfolio risk exposure, correlation clusters, and maximum adverse excursion analysis.',
    status:      'development',
    statusLabel: 'Under Development',
    capabilities: [
      'Real-time portfolio VaR estimation',
      'Dynamic position sizing recommendations',
      'Drawdown detection and capital protection triggers',
      'Cross-asset correlation monitoring',
    ],
  },
  {
    id:          'macro',
    name:        'Macro Intelligence Engine',
    codename:    'Module III',
    purpose:     'Macro regime detection, institutional flow analysis, and global context integration.',
    description: 'Contextualises every trade decision within the prevailing macroeconomic and institutional flow environment. Tracks FII/DII positioning, global regime shifts, and earnings cycle dynamics.',
    status:      'development',
    statusLabel: 'Under Development',
    capabilities: [
      'FII/DII institutional flow pattern detection',
      'Macro regime classification: risk-on / risk-off',
      'Earnings cycle calendar integration',
      'Global market correlation context',
    ],
  },
  {
    id:          'options',
    name:        'Derivatives Intelligence Engine',
    codename:    'Module IV',
    purpose:     'Options flow analysis, OI structure, and volatility surface intelligence.',
    description: 'Structural analysis of the derivatives market — reading OI build-up, PCR dynamics, max pain levels, and implied volatility surfaces to provide a non-price-based view of market direction.',
    status:      'development',
    statusLabel: 'Under Development',
    capabilities: [
      'Options OI build-up and change analysis',
      'PCR dynamics and contrarian signals',
      'Max pain calculation for index and equity',
      'Implied volatility surface modelling',
    ],
  },
  {
    id:          'alpha',
    name:        'Alpha Construction Engine',
    codename:    'Module V',
    purpose:     'Systematic alpha generation, factor research, and portfolio construction.',
    description: 'A research-grade environment for systematic factor exploration, alpha signal construction, and quantitative portfolio building — designed for professional and institutional workflows.',
    status:      'development',
    statusLabel: 'Under Development',
    capabilities: [
      'Factor library: momentum, value, quality, low-volatility',
      'Alpha decay analysis and signal half-life measurement',
      'Portfolio construction with constraints',
      'Walk-forward strategy testing framework',
    ],
  },
  {
    id:          'analytics',
    name:        'Analytics Workspace',
    codename:    'Analytics',
    purpose:     'Institutional-grade reporting, performance attribution, and workflow management.',
    description: 'A professional analytics environment for performance attribution, trade journal analysis, and institutional reporting — designed for compliance, review, and strategic planning.',
    status:      'development',
    statusLabel: 'Under Development',
    capabilities: [
      'Trade journal with behavioral pattern analysis',
      'Performance attribution by strategy, regime, and sector',
      'Institutional-grade reporting and export',
      'Custom watchlist and portfolio workflows',
    ],
  },
];

// ── Navigation ────────────────────────────────────────────────────

export const NAV_LINKS = [
  { label: 'Platform',  href: '/platform' },
  { label: 'Engines',   href: '/engines' },
  { label: 'Vision',    href: '/vision' },
  { label: 'About',     href: '/about' },
  { label: 'Insights',  href: '/insights' },
  { label: 'Contact',   href: '/contact' },
];

// ── Insights ──────────────────────────────────────────────────────

export const INSIGHTS = [
  {
    category: 'Signal Architecture',
    title:    'Why rejection discipline produces better trading outcomes than signal volume',
    excerpt:  'The instinct to generate more signals is deeply human. Institutional systems are built on precisely the opposite principle: filtering aggressively, and emitting only what is structurally sound.',
    readTime: '8 min read',
    date:     'March 2025',
    slug:     'rejection-discipline',
  },
  {
    category: 'Risk Systems',
    title:    'Portfolio fit as a gatekeeper: why individual signal quality is insufficient',
    excerpt:  'A signal may be technically excellent and still destructive to a portfolio. The dimension of portfolio fit — sector exposure, correlation, strategy concentration — is largely absent from retail tooling.',
    readTime: '7 min read',
    date:     'February 2025',
    slug:     'portfolio-fit-gatekeeper',
  },
  {
    category: 'Market Intelligence',
    title:    'The problem with flat confidence scores in trading intelligence systems',
    excerpt:  'A single confidence number obscures more than it reveals. Institutional decision systems decompose confidence into independent components — and understand which ones are driving the score.',
    readTime: '6 min read',
    date:     'January 2025',
    slug:     'confidence-decomposition',
  },
  {
    category: 'Decision Workflows',
    title:    'Scenario-driven decision systems: how market context should change everything',
    excerpt:  'The same breakout setup that performs in a trend-continuation environment can be destructive in a defensive, risk-off regime. Scenario awareness is the difference between structural and fragile decision systems.',
    readTime: '9 min read',
    date:     'December 2024',
    slug:     'scenario-driven-decisions',
  },
];
